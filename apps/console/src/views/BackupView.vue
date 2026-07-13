<script setup lang="ts">
import { ref, watch } from 'vue';

import type { ConsoleApi, ConsolePageState } from '../api.js';

const props = defineProps<{ readonly api?: ConsoleApi }>();
const state = ref<ConsolePageState>();
const password = ref('');
const selected = ref<File>();
const message = ref('');
const error = ref('');

async function load(): Promise<void> {
  state.value = props.api === undefined ? undefined : await props.api.loadPage('backup');
}

async function create(): Promise<void> {
  if (props.api === undefined || password.value === '') return;
  error.value = '';
  try {
    const bundle = await props.api.createBackup(password.value);
    const href = URL.createObjectURL(new Blob([bundle], { type: 'application/vnd.memlume' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = `memlume-${new Date().toISOString().slice(0, 10)}.memlume`;
    link.click();
    URL.revokeObjectURL(href);
    message.value = '備份已建立。請妥善保存密碼與下載的檔案。';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '建立備份失敗。';
  }
}

function choose(event: Event): void {
  selected.value = (event.target as HTMLInputElement).files?.[0];
}

async function restore(): Promise<void> {
  if (props.api === undefined || selected.value === undefined || password.value === '') return;
  if (!window.confirm('還原會取代目前資料庫。已確認備份與密碼正確嗎？')) return;
  error.value = '';
  try {
    await props.api.restoreBackup(new Uint8Array(await selected.value.arrayBuffer()), password.value);
    message.value = '備份已還原，Console 會重新讀取狀態。';
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '還原備份失敗。';
  }
}

watch(() => props.api, load, { immediate: true });
</script>

<template>
  <section>
    <h1>Backup</h1>
    <p class="lede">建立加密完整備份，或上傳已驗證的完整備份進行還原。</p>
    <p v-if="state === undefined" class="notice">輸入 setup token 後即可管理備份。</p>
    <p v-else-if="state.status === 'error'" class="notice error" role="alert">{{ state.message }}</p>
    <p v-else-if="state.status === 'empty'" class="notice">尚無其他 Brain；仍可建立完整備份。</p>
    <div class="backup-actions">
      <label>備份密碼<input v-model="password" type="password" autocomplete="new-password" placeholder="不會被保存" :disabled="api === undefined" /></label>
      <button :disabled="api === undefined || password === ''" @click="create">建立完整備份</button>
      <label>還原檔案<input type="file" accept=".memlume,application/vnd.memlume" :disabled="api === undefined" @change="choose" /></label>
      <button class="danger" :disabled="api === undefined || selected === undefined || password === ''" @click="restore">還原備份</button>
    </div>
    <p v-if="message" class="notice success" role="status" aria-live="polite">{{ message }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  </section>
</template>
