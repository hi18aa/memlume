#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { createInterface } from 'node:readline/promises';
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { verifyBackup, type BackupManifest } from '@memlume/backup';

type Writer = (text: string) => void;

const REQUEST_TIMEOUT_MS = 10_000;
const DAEMON_URL_ERROR = 'daemon URL must be an http://127.0.0.1 or http://[::1] origin.';

interface Io {
  readonly stdout: Writer;
  readonly stderr: Writer;
}

interface GlobalOptions {
  readonly url: string;
  readonly json: boolean;
  readonly token?: string;
  readonly setupToken?: string;
  readonly config?: string;
}

interface ScopeOptions {
  readonly scope?: string;
  readonly domain?: string;
  readonly agent?: string;
  readonly workspace?: string;
  readonly project?: string;
  readonly taskId?: string;
}

class DaemonResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`daemon returned ${status}: ${code}.`);
  }
}

class DaemonConnectionError extends Error {
  constructor() {
    super('unable to reach daemon.');
  }
}

export interface CliRuntime {
  configPath(): string;
  cwd(): string;
  isInteractive(): boolean;
  confirm(question: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFile(path: string, value: string | Uint8Array): Promise<void>;
  mkdir(path: string): Promise<boolean>;
  removeFile(path: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  verifyBackup(path: string, password: string | undefined): Promise<BackupManifest>;
  fetch: typeof fetch;
}

export async function main(
  args: readonly string[],
  io: Io = defaultIo,
  environment: NodeJS.ProcessEnv = process.env,
  runtime: CliRuntime = defaultRuntime,
): Promise<number> {
  const program = createProgram(io, environment, runtime);

  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    io.stderr(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

function createProgram(io: Io, environment: NodeJS.ProcessEnv, runtime: CliRuntime): Command {
  const program = new Command();
  program
    .name('memlume')
    .description('Use a local Memlume daemon.')
    .option('--url <url>', 'daemon URL', 'http://127.0.0.1:3849')
    .option('--token <token>', 'adapter token (defaults to MEMLUME_TOKEN)')
    .option('--setup-token <token>', 'setup token (defaults to MEMLUME_SETUP_TOKEN)')
    .option('--config <path>', 'CLI configuration path')
    .option('--json', 'print raw daemon JSON')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  const event = program.command('event').description('Record daemon events.');
  event
    .command('add <content>')
    .description('Record an event.')
    .requiredOption('--type <eventType>', 'event type')
    .option('--agent <agent>', 'source agent')
    .option('--reference <reference>', 'source reference')
    .action(async (content: string, options: { readonly type: string; readonly agent?: string; readonly reference?: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const source = compact({ type: 'cli', agent: options.agent, reference: options.reference });
      const result = await request(global.url, adapterToken(global.token, environment), '/v1/events', 'POST', {
        rawContent: content,
        eventType: options.type,
        source,
      }, runtime);
      printResult(result, global.json, io.stdout, (body) => `Recorded event ${nestedId(body, 'event') ?? 'event'}.`);
    });

  const remember = program
    .command('remember <content>')
    .description('Save a structured memory.')
    .requiredOption('--kind <kind>', 'policy, preference, fact, or decision')
    .option('--title <title>', 'memory title')
    .option('--scope <scope>', 'global, domain, agent, workspace, project, or task', 'global')
    .option('--domain <domain>', 'scope domain')
    .option('--agent <agent>', 'scope agent')
    .option('--workspace <workspace>', 'scope workspace')
    .option('--project <project>', 'scope project')
    .option('--task-id <taskId>', 'scope task ID')
    .option('--priority <priority>', 'memory priority')
    .option('--confidence <confidence>', 'memory confidence')
    .option('--explicitness <explicitness>', 'memory explicitness')
    .option('--source-event-id <sourceEventId>', 'source event UUID')
    .option('--valid-from <date>', 'valid-from date')
    .option('--valid-until <date>', 'valid-until date')
    .option('--intent <intent...>', 'policy trigger intent')
    .option('--entity <entity...>', 'policy trigger entity')
    .option('--tool <tool...>', 'policy required tool')
    .option('--action-type <type>', 'policy action type')
    .option('--action-target <target>', 'policy action target')
    .option('--exclusive', 'make the policy exclusive')
    .option('--required', 'make the policy required')
    .option('--preference-domain <domain>', 'preference domain')
    .option('--subject <subject>', 'preference or fact subject')
    .option('--dimension <dimension>', 'preference dimension')
    .option('--value <value>', 'preference value')
    .option('--strength <strength>', 'preference strength')
    .option('--predicate <predicate>', 'fact predicate')
    .option('--object <object>', 'fact object')
    .option('--status <status>', 'decision status')
    .option('--rationale <rationale>', 'decision rationale')
    .option('--supersedes <memoryId>', 'decision superseded memory UUID')
    .action(async (content: string, options: RememberOptions, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const body = memoryRequest(content, options);
      const result = await request(global.url, adapterToken(global.token, environment), '/v1/memories', 'POST', body, runtime);
      printResult(result, global.json, io.stdout, (response) => `Saved ${options.kind} memory ${nestedId(response, 'memory') ?? 'memory'}.`);
    });

  program
    .command('search <query>')
    .description('Search memories.')
    .action(async (query: string, _options: unknown, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const result = await request(global.url, adapterToken(global.token, environment), `/v1/memories/search?${new URLSearchParams({ q: query })}`, 'GET', undefined, runtime);
      printResult(result, global.json, io.stdout, searchSummary);
    });

  const context = program.command('context').description('Resolve context through the daemon.');
  addScopeOptions(
    context
      .command('resolve')
      .description('Resolve a context pack.')
      .requiredOption('--intent <intent>', 'intent')
      .option('--task <task>', 'task description')
      .option('--budget <tokens>', 'context budget', '5000')
      .option('--tool <tool...>', 'available tool')
      .option('--entity <entity...>', 'task entity'),
  ).action(async (options: ResolveOptions, command: Command) => {
    const global = command.optsWithGlobals<GlobalOptions>();
    const body = compact({
      intent: options.intent,
      scope: scopeFor(options),
      task: options.task ?? null,
      contextBudget: nonNegativeInteger(options.budget, '--budget'),
      availableTools: options.tool,
      entities: options.entity,
    });
    const result = await request(global.url, adapterToken(global.token, environment), '/v1/context/resolve', 'POST', body, runtime);
    printResult(result, global.json, io.stdout, contextSummary);
  });

  const setup = program
    .command('setup')
    .description('設定本機備份目錄並檢查 daemon。')
    .option('--backup-dir <path>', '本機備份目錄')
    .action(async (options: { readonly backupDir?: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const path = configPath(global, runtime);
      const existing = await readConfig(path, runtime);
      const desired: CliConfig = {
        ...existing.config,
        backupDirectory: options.backupDir ?? existing.config.backupDirectory,
      };
      const existingBackup = await runtime.readFile(`${path}.backup`);
      io.stdout(configDiff(existing.config, desired));
      await runtime.mkdir(dirname(path));
      const backupDirectoryCreated = await runtime.mkdir(desired.backupDirectory);
      if (existing.raw !== undefined) {
        await runtime.writeFile(existingBackup === undefined ? `${path}.backup` : await configSnapshotPath(path, runtime), existing.raw);
      }
      await runtime.writeFile(path, JSON.stringify(desired));
      try {
        await requestSetupJson(global.url, setupToken(global.setupToken, environment), '/v1/setup/diagnostics', 'GET', undefined, runtime);
      } catch {
        if (existing.raw === undefined) {
          await runtime.removeFile(path);
        } else {
          await runtime.writeFile(path, existing.raw);
        }
        if (backupDirectoryCreated) {
          try {
            await runtime.removeEmptyDirectory(desired.backupDirectory);
          } catch {
            // 空目錄清理失敗不得掩蓋設定已回復的結果。
          }
        }
        throw new Error('設定已還原，診斷檢查失敗。');
      }
      io.stdout('設定已套用並通過診斷檢查。\n');
    });

  setup
    .command('adapter <agent>')
    .description('註冊、掛載並驗證 Agent 的本機 Shared Brain profile。')
    .requiredOption('--installation-id <id>', 'Agent 的穩定本機 installation ID')
    .option('--profile-id <id>', 'Agent profile ID', 'default')
    .requiredOption('--project-id <id>', 'Shared Brain 專案 ID')
    .requiredOption('--brain-id <id>', '要掛載的 Project Brain UUIDv7')
    .option('--workspace-path <path>', '選填：Agent workspace 路徑')
    .option('--core-path <path>', 'Memlume Core repository 路徑')
    .action(async (agent: string, options: AdapterSetupOptions, command: Command) => {
      const clientType = supportedAdapter(agent);
      const global = command.optsWithGlobals<GlobalOptions>();
      const path = configPath(global, runtime);
      const existing = await readConfig(path, runtime);
      const duplicate = existing.config.adapters.find((profile) => (
        profile.clientType === clientType
        && profile.installationId === options.installationId
        && profile.profileId === options.profileId
      ));
      if (duplicate !== undefined) {
        throw new Error('此 Adapter profile 已存在。請使用既有設定，或先明確移除／輪替它。');
      }

      const setupSecret = setupToken(global.setupToken, environment);
      const registered = await requestSetupJson(global.url, setupSecret, '/v1/setup/installations', 'GET', undefined, runtime);
      const existingInstallation = arrayValue(registered, 'installations').some((installation) => (
        objectString(installation, 'clientType') === clientType
        && objectString(installation, 'installationId') === options.installationId
        && objectString(installation, 'profileId') === options.profileId
      ));
      if (existingInstallation) {
        throw new Error('daemon already has this Adapter installation, but its local profile is missing. Restore the local config or rotate the token explicitly.');
      }
      const registration = await requestSetupJson(global.url, setupSecret, '/v1/setup/installations', 'POST', {
        clientType,
        installationId: required(options.installationId, '--installation-id'),
        profileId: required(options.profileId, '--profile-id'),
        displayName: `Memlume ${adapterDisplayName(clientType)}`,
      }, runtime);
      const installation = objectValue(registration, 'installation');
      const agentInstallationId = requiredResponseString(installation, 'id', 'installation registration');
      const token = requiredResponseString(registration, 'token', 'installation registration');
      const brainId = required(options.brainId, '--brain-id');
      const projectId = required(options.projectId, '--project-id');
      await requestSetupJson(global.url, setupSecret, '/v1/setup/mounts', 'POST', {
        agentInstallationId,
        brainId,
        access: 'read_write',
      }, runtime);

      const desired: CliConfig = {
        ...existing.config,
        adapters: [
          ...existing.config.adapters,
          compact({
            clientType,
            installationId: required(options.installationId, '--installation-id'),
            profileId: required(options.profileId, '--profile-id'),
            projectId,
            brainId,
            token,
            corePath: options.corePath ?? runtime.cwd(),
            workspacePath: options.workspacePath,
            daemonUrl: global.url,
          }),
        ],
      };
      await runtime.mkdir(dirname(path));
      if (existing.raw !== undefined) {
        const backupPath = await runtime.readFile(`${path}.backup`) === undefined ? `${path}.backup` : await configSnapshotPath(path, runtime);
        await runtime.writeFile(backupPath, existing.raw);
      }
      await runtime.writeFile(path, JSON.stringify(desired));
      try {
        await request(global.url, token, '/v1/context/resolve', 'POST', {
          intent: 'shared_memory',
          scope: { level: 'project', projectId },
          task: 'Memlume adapter setup smoke test.',
          contextBudget: 1,
          availableTools: [],
          entities: [],
        }, runtime);
      } catch {
        if (existing.raw === undefined) {
          await runtime.removeFile(path);
        } else {
          await runtime.writeFile(path, existing.raw);
        }
        throw new Error('Adapter profile 已還原，daemon smoke test 失敗。');
      }
      io.stdout(`${adapterDisplayName(clientType)} adapter profile is registered, mounted, and passed the daemon smoke test.\n`);
    });

  program
    .command('doctor')
    .description('檢查 daemon 與可選的受保護診斷資訊。')
    .action(async (_options: unknown, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const health = await requestPublicJson(global.url, '/v1/health', runtime);
      const diagnostics = global.setupToken === undefined && environment.MEMLUME_SETUP_TOKEN === undefined
        ? undefined
        : await requestSetupJson(global.url, setupToken(global.setupToken, environment), '/v1/setup/diagnostics', 'GET', undefined, runtime);
      if (global.json) {
        io.stdout(`${JSON.stringify(compact({ health, diagnostics }))}\n`);
        return;
      }
      io.stdout(doctorSummary(health, diagnostics));
    });

  const brain = program.command('brain').description('管理 Shared Brain 匯出與匯入。');
  brain
    .command('list')
    .description('列出 Shared Brain。')
    .action(async (_options: unknown, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const result = await requestSetupJson(global.url, setupToken(global.setupToken, environment), '/v1/setup/brains', 'GET', undefined, runtime);
      printResult(result, global.json, io.stdout, brainsSummary);
    });
  brain
    .command('export <brainId>')
    .description('匯出單一 Brain。')
    .requiredOption('--output <path>', '輸出 .memlume 檔案')
    .option('--password-env <name>', '讀取備份密碼的環境變數')
    .action(async (brainId: string, options: PasswordOptions & { readonly output: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const password = backupPassword(options, environment);
      const bundle = await requestSetupBinary(
        global.url,
        setupToken(global.setupToken, environment),
        '/v1/setup/backups',
        JSON.stringify(compact({ brainId, password })),
        runtime,
      );
      await runtime.writeFile(options.output, bundle);
      io.stdout(`已匯出 Brain ${brainId} 至 ${options.output}。\n`);
    });
  brain
    .command('import <path>')
    .description('匯入單一 Brain bundle。')
    .option('--name <name>', '匯入後的 Brain 名稱')
    .option('--password-env <name>', '讀取備份密碼的環境變數')
    .action(async (path: string, options: PasswordOptions & { readonly name?: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const password = backupPassword(options, environment);
      const query = options.name === undefined ? '' : `?${new URLSearchParams({ name: options.name })}`;
      const result = await requestSetupRaw(
        global.url,
        setupToken(global.setupToken, environment),
        `/v1/setup/brains/import${query}`,
        await requiredFile(path, runtime),
        password,
        runtime,
      );
      const brainId = nestedId(result, 'brain');
      io.stdout(`已匯入 Brain ${brainId ?? 'brain'}。\n`);
    });

  const backup = program.command('backup').description('管理本機 .memlume 備份。');
  backup
    .command('create')
    .description('建立完整備份。')
    .requiredOption('--output <path>', '輸出 .memlume 檔案')
    .option('--password-env <name>', '讀取備份密碼的環境變數')
    .action(async (options: PasswordOptions & { readonly output: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const password = requiredFullBackupPassword(options, environment);
      const bundle = await requestSetupBinary(
        global.url,
        setupToken(global.setupToken, environment),
        '/v1/setup/backups',
        JSON.stringify(compact({ password })),
        runtime,
      );
      await runtime.writeFile(options.output, bundle);
      io.stdout(`已建立完整備份 ${options.output}。\n`);
    });
  backup
    .command('list')
    .description('只列出本機 .memlume 檔案。')
    .option('--directory <path>', '備份目錄')
    .action(async (options: { readonly directory?: string }, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      const directory = options.directory ?? (await readConfig(configPath(global, runtime), runtime)).config.backupDirectory;
      const files = (await runtime.readdir(directory)).filter((file) => file.endsWith('.memlume')).sort();
      io.stdout(files.length === 0 ? '找不到本機備份。\n' : `${files.join('\n')}\n`);
    });
  backup
    .command('verify <path>')
    .description('離線驗證本機備份。')
    .option('--password-env <name>', '讀取備份密碼的環境變數')
    .action(async (path: string, options: PasswordOptions) => {
      const manifest = await runtime.verifyBackup(path, backupPassword(options, environment));
      io.stdout(`備份驗證成功：${manifest.scope === 'full' ? '完整備份' : '單一 Brain'}，${manifest.brainIds.length} 個 Brain。\n`);
    });
  backup
    .command('restore <path>')
    .description('還原完整備份。')
    .option('--yes', '確認還原，供非互動環境使用')
    .option('--password-env <name>', '讀取備份密碼的環境變數')
    .action(async (path: string, options: PasswordOptions & { readonly yes?: boolean }, command: Command) => {
      if (!options.yes) {
        if (!runtime.isInteractive()) {
          throw new Error('非互動環境還原備份必須明確傳入 --yes。');
        }
        if (!await runtime.confirm('此操作會取代目前資料庫，是否繼續？')) {
          throw new Error('已取消還原備份。');
        }
      }
      const global = command.optsWithGlobals<GlobalOptions>();
      const password = backupPassword(options, environment);
      const manifest = await runtime.verifyBackup(path, password);
      if (manifest.scope !== 'full') {
        throw new Error('單一 Brain 匯出不能還原，請改用 brain import。');
      }
      await requestSetupRaw(
        global.url,
        setupToken(global.setupToken, environment),
        '/v1/setup/backups/restore',
        await requiredFile(path, runtime),
        password,
        runtime,
      );
      io.stdout('已還原備份。\n');
    });

  return program;
}

function addScopeOptions(command: Command): Command {
  return command
    .option('--scope <scope>', 'global, domain, agent, workspace, project, or task', 'global')
    .option('--domain <domain>', 'scope domain')
    .option('--agent <agent>', 'scope agent')
    .option('--workspace <workspace>', 'scope workspace')
    .option('--project <project>', 'scope project')
    .option('--task-id <taskId>', 'scope task ID');
}

type RememberOptions = ScopeOptions & {
  readonly kind: string;
  readonly title?: string;
  readonly priority?: string;
  readonly confidence?: string;
  readonly explicitness?: string;
  readonly sourceEventId?: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly intent?: string[];
  readonly entity?: string[];
  readonly tool?: string[];
  readonly actionType?: string;
  readonly actionTarget?: string;
  readonly exclusive?: boolean;
  readonly required?: boolean;
  readonly preferenceDomain?: string;
  readonly subject?: string;
  readonly dimension?: string;
  readonly value?: string;
  readonly strength?: string;
  readonly predicate?: string;
  readonly object?: string;
  readonly status?: string;
  readonly rationale?: string;
  readonly supersedes?: string;
};

interface ResolveOptions extends ScopeOptions {
  readonly intent: string;
  readonly task?: string;
  readonly budget: string;
  readonly tool?: string[];
  readonly entity?: string[];
}

interface PasswordOptions {
  readonly passwordEnv?: string;
}

interface CliConfig {
  readonly version: 1;
  readonly backupDirectory: string;
  readonly adapters: readonly AdapterProfile[];
}

interface AdapterProfile {
  readonly clientType: SupportedAdapter;
  readonly installationId: string;
  readonly profileId: string;
  readonly projectId: string;
  readonly brainId: string;
  readonly token: string;
  readonly corePath: string;
  readonly workspacePath?: string;
  readonly daemonUrl: string;
}

interface AdapterSetupOptions {
  readonly installationId: string;
  readonly profileId: string;
  readonly projectId: string;
  readonly brainId: string;
  readonly workspacePath?: string;
  readonly corePath?: string;
}

const supportedAdapters = ['hermes', 'codex', 'openclaw', 'claude-code'] as const;
type SupportedAdapter = (typeof supportedAdapters)[number];

function memoryRequest(content: string, options: RememberOptions): Record<string, unknown> {
  const base = compact({
    kind: options.kind,
    title: options.title,
    canonicalText: content,
    scope: scopeFor(options),
    priority: optionalInteger(options.priority, '--priority'),
    confidence: optionalUnitNumber(options.confidence, '--confidence'),
    explicitness: optionalUnitNumber(options.explicitness, '--explicitness'),
    sourceEventId: options.sourceEventId,
    validFrom: options.validFrom,
    validUntil: options.validUntil,
  });

  switch (options.kind) {
    case 'policy':
      return {
        ...base,
        structuredData: {
          trigger: compact({
            intents: requiredList(options.intent, '--intent'),
            entities: options.entity,
            requiredToolAvailability: options.tool,
          }),
          action: { type: required(options.actionType, '--action-type'), target: required(options.actionTarget, '--action-target') },
          constraints: compact({ exclusive: options.exclusive || undefined, required: options.required || undefined }),
        },
      };
    case 'preference':
      return {
        ...base,
        structuredData: {
          domain: required(options.preferenceDomain, '--preference-domain'),
          subject: required(options.subject, '--subject'),
          dimension: required(options.dimension, '--dimension'),
          value: required(options.value, '--value'),
          strength: unitNumber(options.strength, '--strength'),
          confidence: unitNumber(options.confidence, '--confidence'),
        },
      };
    case 'fact':
      return {
        ...base,
        structuredData: compact({
          subject: required(options.subject, '--subject'),
          predicate: required(options.predicate, '--predicate'),
          object: required(options.object, '--object'),
          validFrom: options.validFrom,
          validUntil: options.validUntil,
          confidence: unitNumber(options.confidence, '--confidence'),
        }),
      };
    case 'decision':
      return {
        ...base,
        structuredData: compact({
          title: required(options.title, '--title'),
          status: required(options.status, '--status'),
          rationale: [required(options.rationale, '--rationale')],
          supersedes: options.supersedes,
        }),
      };
    default:
      throw new Error('--kind must be policy, preference, fact, or decision.');
  }
}

function scopeFor(options: ScopeOptions): Record<string, unknown> {
  switch (options.scope ?? 'global') {
    case 'global':
      return { level: 'global' };
    case 'domain':
      return { level: 'domain', domain: required(options.domain, '--domain') };
    case 'agent':
      return compact({ level: 'agent', domain: options.domain, agentId: required(options.agent, '--agent') });
    case 'workspace':
      return compact({ level: 'workspace', domain: options.domain, agentId: options.agent, workspace: required(options.workspace, '--workspace') });
    case 'project':
      return compact({
        level: 'project',
        domain: options.domain,
        agentId: options.agent,
        workspace: options.workspace,
        projectId: required(options.project, '--project'),
      });
    case 'task':
      return compact({
        level: 'task',
        domain: options.domain,
        agentId: options.agent,
        workspace: options.workspace,
        projectId: options.project,
        taskId: required(options.taskId, '--task-id'),
      });
    default:
      throw new Error('--scope must be global, domain, agent, workspace, project, or task.');
  }
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${option} is required.`);
  }
  return value;
}

function requiredList(value: string[] | undefined, option: string): string[] {
  if (value === undefined || value.length === 0 || value.some((item) => item.trim() === '')) {
    throw new Error(`${option} is required.`);
  }
  return value;
}

function optionalInteger(value: string | undefined, option: string): number | undefined {
  return value === undefined ? undefined : integer(value, option);
}

function nonNegativeInteger(value: string, option: string): number {
  const parsed = integer(value, option);
  if (parsed < 0) {
    throw new Error(`${option} must be a non-negative integer.`);
  }
  return parsed;
}

function integer(value: string, option: string): number {
  if (value.trim() === '') {
    throw new Error(`${option} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${option} must be an integer.`);
  }
  return parsed;
}

function optionalUnitNumber(value: string | undefined, option: string): number | undefined {
  return value === undefined ? undefined : unitNumber(value, option);
}

function unitNumber(value: string | undefined, option: string): number {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${option} must be a number from 0 to 1.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${option} must be a number from 0 to 1.`);
  }
  return parsed;
}

function adapterToken(option: string | undefined, environment: NodeJS.ProcessEnv): string {
  const token = option ?? environment.MEMLUME_TOKEN;
  if (token === undefined || token.trim() === '') {
    throw new Error('adapter token is required. Create one through the protected setup API, then set MEMLUME_TOKEN or pass --token.');
  }
  return token;
}

function setupToken(option: string | undefined, environment: NodeJS.ProcessEnv): string {
  const token = option ?? environment.MEMLUME_SETUP_TOKEN;
  if (token === undefined || token.trim() === '') {
    throw new Error('setup token is required. Set MEMLUME_SETUP_TOKEN or pass --setup-token.');
  }
  return token;
}

function backupPassword(options: PasswordOptions, environment: NodeJS.ProcessEnv): string | undefined {
  const variable = options.passwordEnv ?? 'MEMLUME_BACKUP_PASSWORD';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error('--password-env must be an environment variable name.');
  }
  const password = environment[variable];
  if (password === '') {
    throw new Error('backup password environment variable must not be empty.');
  }
  return password;
}

function requiredFullBackupPassword(options: PasswordOptions, environment: NodeJS.ProcessEnv): string {
  const password = backupPassword(options, environment);
  if (password === undefined) {
    throw new Error('完整備份必須提供 --password-env 或 MEMLUME_BACKUP_PASSWORD。');
  }
  return password;
}

async function request(url: string, token: string, path: string, method: 'GET' | 'POST', body: unknown, runtime: CliRuntime): Promise<unknown> {
  const response = await sendRequest(url, path, method, { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body === undefined ? undefined : JSON.stringify(body), runtime);
  if (response.ok) {
    return responseJson(response);
  }
  const result = await responseJsonOrUndefined(response);
  if (response.status === 401) {
    throw new Error('adapter authentication failed. Create a new token through the protected setup API and update MEMLUME_TOKEN.');
  }
  throw new DaemonResponseError(response.status, daemonErrorCode(result));
}

async function requestPublicJson(url: string, path: string, runtime: CliRuntime): Promise<unknown> {
  const response = await sendRequest(url, path, 'GET', {}, undefined, runtime);
  if (response.ok) {
    return responseJson(response);
  }
  throw new DaemonResponseError(response.status, daemonErrorCode(await responseJsonOrUndefined(response)));
}

async function requestSetupJson(
  url: string,
  token: string,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  runtime: CliRuntime,
): Promise<unknown> {
  const response = await sendRequest(
    url,
    path,
    method,
    { 'x-memlume-setup-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body === undefined ? undefined : JSON.stringify(body),
    runtime,
  );
  if (response.ok) {
    return responseJson(response);
  }
  throwSetupResponse(response.status, await responseJsonOrUndefined(response));
}

async function requestSetupBinary(url: string, token: string, path: string, body: string, runtime: CliRuntime): Promise<Uint8Array> {
  const response = await sendRequest(url, path, 'POST', { 'x-memlume-setup-token': token, 'content-type': 'application/json' }, body, runtime);
  if (response.ok) {
    return new Uint8Array(await response.arrayBuffer());
  }
  throwSetupResponse(response.status, await responseJsonOrUndefined(response));
}

async function requestSetupRaw(
  url: string,
  token: string,
  path: string,
  bundle: Uint8Array,
  password: string | undefined,
  runtime: CliRuntime,
): Promise<unknown> {
  const response = await sendRequest(
    url,
    path,
    'POST',
    compact({ 'x-memlume-setup-token': token, 'x-memlume-backup-password': password, 'content-type': 'application/vnd.memlume' }),
    bundle,
    runtime,
  );
  if (response.ok) {
    return responseJson(response);
  }
  throwSetupResponse(response.status, await responseJsonOrUndefined(response));
}

function throwSetupResponse(status: number, result: unknown): never {
  if (status === 401) {
    throw new Error('setup authentication failed. Set MEMLUME_SETUP_TOKEN or pass --setup-token.');
  }
  throw new DaemonResponseError(status, daemonErrorCode(result));
}

async function sendRequest(
  url: string,
  path: string,
  method: 'GET' | 'POST',
  headers: Record<string, string | undefined>,
  body: string | Uint8Array | undefined,
  runtime: CliRuntime,
): Promise<Response> {
  const endpoint = daemonEndpoint(url, path);
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      requestHeaders.set(name, value);
    }
  }
  const requestBody = typeof body === 'string' || body === undefined ? body : Uint8Array.from(body).buffer;
  let response: Response;
  try {
    response = await runtime.fetch(endpoint, {
      method,
      headers: requestHeaders,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error('daemon request timed out.');
    }
    throw new DaemonConnectionError();
  }

  return response;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('daemon returned an invalid response.');
  }
}

async function responseJsonOrUndefined(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function configPath(global: GlobalOptions, runtime: CliRuntime): string {
  return global.config ?? runtime.configPath();
}

async function configSnapshotPath(path: string, runtime: CliRuntime): Promise<string> {
  for (let number = 1; ; number += 1) {
    const snapshot = `${path}.backup.snapshot-${number}`;
    if (await runtime.readFile(snapshot) === undefined) {
      return snapshot;
    }
  }
}

async function readConfig(path: string, runtime: CliRuntime): Promise<{ readonly config: CliConfig; readonly raw?: Uint8Array }> {
  const raw = await runtime.readFile(path);
  if (raw === undefined) {
    return { config: { version: 1, backupDirectory: join(runtime.cwd(), 'memlume-backups'), adapters: [] } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error('CLI configuration is invalid.');
  }
  if (
    typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { backupDirectory?: unknown }).backupDirectory !== 'string'
    || (parsed as { backupDirectory: string }).backupDirectory.trim() === ''
  ) {
    throw new Error('CLI configuration is invalid.');
  }
  const adapters = objectValue(parsed, 'adapters');
  if (adapters !== undefined && (!Array.isArray(adapters) || adapters.some((profile) => !isAdapterProfile(profile)))) {
    throw new Error('CLI configuration is invalid.');
  }
  return {
    config: {
      version: 1,
      backupDirectory: (parsed as { backupDirectory: string }).backupDirectory,
      adapters: (adapters ?? []) as AdapterProfile[],
    },
    raw,
  };
}

function configDiff(current: CliConfig, desired: CliConfig): string {
  if (current.backupDirectory === desired.backupDirectory) {
    return '設定未變更。\n';
  }
  return `設定變更：\nbackupDirectory: ${current.backupDirectory} -> ${desired.backupDirectory}\n`;
}

function supportedAdapter(value: string): SupportedAdapter {
  if ((supportedAdapters as readonly string[]).includes(value)) {
    return value as SupportedAdapter;
  }
  throw new Error(`Agent must be one of: ${supportedAdapters.join(', ')}.`);
}

function adapterDisplayName(adapter: SupportedAdapter): string {
  switch (adapter) {
    case 'claude-code':
      return 'Claude Code';
    case 'openclaw':
      return 'OpenClaw';
    case 'codex':
      return 'Codex';
    case 'hermes':
      return 'Hermes';
  }
}

function requiredResponseString(value: unknown, key: string, resource: string): string {
  const result = objectString(value, key);
  if (result === undefined) {
    throw new Error(`${resource} returned an invalid response.`);
  }
  return result;
}

function isAdapterProfile(value: unknown): value is AdapterProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const profile = value as Record<string, unknown>;
  return typeof profile.clientType === 'string'
    && (supportedAdapters as readonly string[]).includes(profile.clientType)
    && typeof profile.installationId === 'string' && profile.installationId.trim() !== ''
    && typeof profile.profileId === 'string' && profile.profileId.trim() !== ''
    && typeof profile.projectId === 'string' && profile.projectId.trim() !== ''
    && typeof profile.brainId === 'string' && profile.brainId.trim() !== ''
    && typeof profile.token === 'string' && profile.token.trim() !== ''
    && typeof profile.corePath === 'string' && profile.corePath.trim() !== ''
    && (profile.workspacePath === undefined || typeof profile.workspacePath === 'string')
    && typeof profile.daemonUrl === 'string' && profile.daemonUrl.trim() !== '';
}

async function requiredFile(path: string, runtime: CliRuntime): Promise<Uint8Array> {
  const file = await runtime.readFile(path);
  if (file === undefined) {
    throw new Error(`找不到檔案：${path}。`);
  }
  return file;
}

function doctorSummary(health: unknown, diagnostics: unknown): string {
  const healthStatus = objectString(health, 'status') ?? objectString(health, 'health') ?? 'unknown';
  if (diagnostics === undefined) {
    return `Daemon: ${healthStatus}.\n未提供 setup token，略過受保護診斷。\n`;
  }
  const schema = objectValue(diagnostics, 'schema');
  return [
    `Daemon: ${healthStatus}.`,
    `Integrity: ${objectString(diagnostics, 'integrity') ?? 'unknown'}.`,
    `Migrations: ${arrayValue(schema, 'migrations').length}.`,
    `Brains: ${arrayValue(diagnostics, 'brains').length}.`,
    `Mounts: ${arrayValue(diagnostics, 'mounts').length}.`,
  ].join('\n').concat('\n');
}

function brainsSummary(result: unknown): string {
  const brains = arrayValue(result, 'brains');
  if (brains.length === 0) {
    return 'No Brains found.';
  }
  return brains.map((brain) => {
    const id = objectString(brain, 'id') ?? 'brain';
    const name = objectString(brain, 'name');
    return name === undefined ? id : `${id}: ${name}`;
  }).join('\n');
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  const candidate = objectValue(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}

function arrayValue(value: unknown, key: string): readonly unknown[] {
  const candidate = objectValue(value, key);
  return Array.isArray(candidate) ? candidate : [];
}

function daemonEndpoint(value: string, path: string): URL {
  let daemonUrl: URL;
  try {
    daemonUrl = new URL(value);
  } catch {
    throw new Error(DAEMON_URL_ERROR);
  }

  if (
    daemonUrl.protocol !== 'http:' ||
    (daemonUrl.hostname !== '127.0.0.1' && daemonUrl.hostname !== '[::1]') ||
    daemonUrl.username !== '' ||
    daemonUrl.password !== '' ||
    daemonUrl.pathname !== '/' ||
    daemonUrl.search !== '' ||
    daemonUrl.hash !== ''
  ) {
    throw new Error(DAEMON_URL_ERROR);
  }

  return new URL(path, daemonUrl);
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError';
}

function daemonErrorCode(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string') {
    return result.error;
  }
  return 'request_failed';
}

function printResult(result: unknown, json: boolean, write: Writer, summary: (body: unknown) => string): void {
  write(json ? `${JSON.stringify(result)}\n` : `${summary(result)}\n`);
}

function nestedId(result: unknown, key: string): string | undefined {
  if (typeof result !== 'object' || result === null || !(key in result)) {
    return undefined;
  }
  const nested = (result as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null && 'id' in nested && typeof nested.id === 'string' ? nested.id : undefined;
}

function searchSummary(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('memories' in result) || !Array.isArray(result.memories)) {
    return 'No memories found.';
  }
  if (result.memories.length === 0) {
    return 'No memories found.';
  }
  return result.memories
    .map((memory) => {
      if (typeof memory !== 'object' || memory === null) {
        return 'memory';
      }
      const kind = typeof memory.kind === 'string' ? memory.kind : 'memory';
      const id = typeof memory.id === 'string' ? ` ${memory.id}` : '';
      const text = typeof memory.title === 'string' ? memory.title : typeof memory.canonicalText === 'string' ? memory.canonicalText : '';
      return `${kind}${id}${text === '' ? '' : `: ${text}`}`;
    })
    .join('\n');
}

function contextSummary(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('context' in result) || typeof result.context !== 'object' || result.context === null) {
    return 'Resolved context.';
  }
  const context = result.context as Record<string, unknown>;
  const traceId = typeof context.traceId === 'string' ? ` ${context.traceId}` : '';
  const directiveCount = Array.isArray(context.directives) ? context.directives.length : 0;
  return `Resolved context${traceId}: ${directiveCount} directives.`;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'command failed.';
}

const defaultRuntime: CliRuntime = {
  configPath: () => join(homedir(), '.config', 'memlume', 'config.json'),
  cwd: () => process.cwd(),
  isInteractive: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  async confirm(question: string): Promise<boolean> {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await prompt.question(`${question} [y/N] `)).trim().toLowerCase() === 'y';
    } finally {
      prompt.close();
    }
  },
  async readFile(path: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(path);
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  },
  writeFile: async (path, value) => writeFile(path, value, { mode: 0o600 }),
  async mkdir(path: string): Promise<boolean> {
    return (await mkdir(path, { recursive: true })) !== undefined;
  },
  async removeFile(path: string): Promise<void> {
    await unlink(path);
  },
  async removeEmptyDirectory(path: string): Promise<void> {
    await rmdir(path);
  },
  async readdir(path: string): Promise<readonly string[]> {
    try {
      return await readdir(path);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  },
  verifyBackup: (path, password) => verifyBackup({ backupPath: path, ...(password === undefined ? {} : { password }) }),
  fetch,
};

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

if (process.argv[1]?.endsWith('index.js')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
