// Keep host-specific config and tool names here; task/review/report data stays portable.
const HOSTS = {
  codex: {
    id: 'codex', name: 'Codex', directory: '.codex', env: 'CODEX_HOME', config: 'hooks.json',
    tools: ['apply_patch'],
    activation: '在本地 Codex 的 /hooks 中审阅并信任这 3 个 Hook，再打开或恢复项目会话。',
  },
  'claude-code': {
    id: 'claude-code', name: 'Claude Code', directory: '.claude', env: 'CLAUDE_CONFIG_DIR', config: 'settings.json',
    tools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    activation: '重启 Claude Code 会话，在 /hooks 中核对这 3 个 Hook；按客户端要求确认启用。',
  },
  workbuddy: {
    id: 'workbuddy', name: 'WorkBuddy', directory: '.workbuddy', env: 'WORKBUDDY_CONFIG_DIR', config: 'settings.json',
    tools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    activation: '重启 WorkBuddy 并新建项目会话，在 Hooks 管理入口核对配置；按客户端要求确认启用。',
  },
  codebuddy: {
    id: 'codebuddy', name: 'CodeBuddy Code', directory: '.codebuddy', env: 'CODEBUDDY_CONFIG_DIR', config: 'settings.json',
    tools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    activation: '重启 CodeBuddy Code 会话，在 /hooks 中审阅这 3 个 Hook 并确认启用。',
  },
};

export function resolveHost(value = 'codex') {
  const id = { claude: 'claude-code', claudecode: 'claude-code' }[value] ?? value;
  if (!Object.hasOwn(HOSTS, id)) throw new Error(`不支持的宿主：${value}。可选 codex、claude-code、workbuddy、codebuddy。`);
  return HOSTS[id];
}

export function supportedHosts() {
  return Object.values(HOSTS).map(host => ({ ...host, tools: [...host.tools] }));
}
