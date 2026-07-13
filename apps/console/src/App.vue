<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, RouterView } from 'vue-router';

import { createConsoleApi } from './api.js';

const token = ref('');
const activeToken = ref('');
const api = computed(() => activeToken.value === '' ? undefined : createConsoleApi({ setupToken: activeToken.value }));

function connect(): void {
  activeToken.value = token.value.trim();
  token.value = '';
}
</script>

<template>
  <header class="site-header">
    <div>
      <a class="brand" href="/console/">Memlume</a>
      <span>Shared Brain Console</span>
    </div>
    <form class="token-form" @submit.prevent="connect">
      <label for="setup-token">Setup token</label>
      <input id="setup-token" v-model="token" type="password" autocomplete="off" placeholder="只保留於這個分頁記憶體" />
      <button :disabled="token.trim() === ''">連線</button>
    </form>
  </header>

  <div class="shell">
    <nav aria-label="Console navigation">
      <RouterLink to="/">Dashboard</RouterLink>
      <RouterLink to="/brains">Brains</RouterLink>
      <RouterLink to="/memories">Memories</RouterLink>
      <RouterLink to="/inbox">Inbox</RouterLink>
      <RouterLink to="/agents">Agents</RouterLink>
      <RouterLink to="/backup">Backup</RouterLink>
    </nav>
    <main>
      <RouterView v-slot="{ Component }">
        <component :is="Component" :api="api" />
      </RouterView>
    </main>
  </div>
</template>
