import { isIP } from 'net';
import { isPortNumber } from './validation';
import { PackageManager } from './types';

export interface ServerOptions {
    port: number | null;
    host: string;
    https: boolean;
}

/** Accept only hostnames/IP literals, never URLs, flags or shell syntax. */
export function isValidServerHost(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    if (value === '') {
        return true;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return isIP(value.slice(1, -1)) === 6;
    }
    if (isIP(value)) {
        return true;
    }
    return value.length <= 253 && value.split('.').every(label =>
        /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

/** Runtime validation is required even when VS Code's settings UI has a schema. */
export function validateServerOptions(options: ServerOptions): void {
    if (options.port !== null && !isPortNumber(options.port)) {
        throw new Error('Invalid nuxt-dev-server.port: expected null or an integer between 1 and 65535.');
    }
    if (!isValidServerHost(options.host)) {
        throw new Error('Invalid nuxt-dev-server.host: expected a hostname, IPv4 or IPv6 address (no URL, whitespace or shell metacharacters).');
    }
    if (typeof options.https !== 'boolean') {
        throw new Error('Invalid nuxt-dev-server.https: expected a boolean.');
    }
}

export function serverCommandArgs(manager: PackageManager, command: string, options: ServerOptions): string[] {
    validateServerOptions(options);
    const flags: string[] = [];
    if (options.port !== null) {
        flags.push('--port', String(options.port));
    }
    if (options.host) {
        flags.push('--host', options.host.replace(/^\[|\]$/g, ''));
    }
    if (options.https) {
        flags.push('--https');
    }
    return manager === 'npm'
        ? ['run', command, ...(flags.length ? ['--', ...flags] : [])]
        : [command, ...flags];
}

/** Polling cannot discover a scheme/host; use configured values without changing the detected port. */
export function fallbackServerUrl(port: number, options: ServerOptions): string {
    validateServerOptions(options);
    if (!isPortNumber(port)) {
        throw new Error('Invalid server port.');
    }
    let host = options.host || 'localhost';
    if (isIP(host) === 6) {
        host = `[${host}]`;
    }
    return `${options.https ? 'https' : 'http'}://${host}:${port}`;
}

export interface PrintedServerUrl {
    url: string;
    port: number;
    local: boolean;
}

/** Prefer Nuxt's Local line over Network/docs URLs, retaining the printed authority/path. */
export function parsePrintedServerUrl(output: string): PrintedServerUrl | null {
    // Nuxt colors the banner with ANSI SGR sequences.
    // eslint-disable-next-line no-control-regex
    const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
    const candidates = [...clean.matchAll(/https?:\/\/(?:\[[a-f\d:.]+\]|[a-z\d.-]+):\d+(?:\/[^\s<>"']*)?(?=$|[\s<>"'])/gi)];
    const parsed: PrintedServerUrl[] = [];
    for (const match of candidates) {
        const url = match[0].replace(/^(https?:\/\/[^/]+)\/$/, '$1');
        try {
            const value = new URL(url);
            const port = Number(/:(\d+)(?:\/|$)/.exec(url)?.[1]);
            if (!isPortNumber(port) || !isValidServerHost(value.hostname)) {
                continue;
            }
            const lineStart = clean.lastIndexOf('\n', match.index) + 1;
            const prefix = clean.slice(lineStart, match.index);
            if (/Network\s*:/i.test(prefix)) {
                continue;
            }
            parsed.push({ url, port, local: /Local\s*:/i.test(prefix) });
        } catch {
            // Ignore malformed URLs in unrelated build output.
        }
    }
    return parsed.find(value => value.local) ?? parsed[0] ?? null;
}
