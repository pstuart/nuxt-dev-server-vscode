/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
    DEFAULT_PORT: 3000,
    UPDATE_INTERVAL_MS: 5000, // Increased from 3000 to reduce CPU usage
    STOP_CLEANUP_WAIT_MS: 1000,
    RESTART_DELAY_MS: 1500,
    SERVER_START_TIMEOUT_MS: 30000,
    COMMAND_TRUNCATE_LENGTH: 80,
    COMMAND_TRUNCATE_SUFFIX_LENGTH: 77,
} as const;

/**
 * Process detection patterns
 */
export const PROCESS_PATTERNS = {
    NUXT_DEV_PREVIEW: 'node.*nuxt.*(dev|preview)',
    PORT_REGEX: /http:\/\/localhost:(\d+)/,
    LSOF_PORT_REGEX: /:(\d+)\s+\(LISTEN\)/,
} as const;

/**
 * Lock files for package manager detection
 */
export const LOCK_FILES = {
    YARN: 'yarn.lock',
    PNPM: 'pnpm-lock.yaml',
    BUN: 'bun.lockb',
    NPM: 'package-lock.json',
} as const;

/**
 * Nuxt configuration file patterns
 */
export const NUXT_CONFIG_FILES = [
    'nuxt.config.ts',
    'nuxt.config.js',
    'nuxt.config.mjs',
    'nuxt.config.mts',
] as const;

/**
 * Output channel names
 */
export const OUTPUT_CHANNELS = {
    DEV_SERVER: 'Nuxt Dev Server',
    INSTANCES: 'Nuxt Instances',
    VERSION: 'Nuxt Version',
    DEBUG: 'Nuxt Dev Server Debug',
} as const;

/**
 * Status bar icons and text
 */
export const STATUS_BAR = {
    ICON_RUNNING: '$(radio-tower)',
    ICON_STOPPED: '$(circle-slash)',
    TEXT_DEV: 'Nuxt Dev',
    TEXT_NUXT: 'Nuxt',
} as const;

/**
 * Extension command IDs
 */
export const COMMANDS = {
    START: 'nuxt-dev-server.start',
    STOP: 'nuxt-dev-server.stop',
    RESTART: 'nuxt-dev-server.restart',
    SHOW_ALL: 'nuxt-dev-server.showAll',
    KILL_ALL: 'nuxt-dev-server.killAll',
    LIST_AND_KILL: 'nuxt-dev-server.listAndKill',
    OPEN_BROWSER: 'nuxt-dev-server.openBrowser',
    SHOW_VERSION: 'nuxt-dev-server.showVersion',
    SHOW_MENU: 'nuxt-dev-server.showMenu',
} as const;

/**
 * Configuration section name
 */
export const CONFIG_SECTION = 'nuxt-dev-server' as const;
