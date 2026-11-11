import { describe, expect, it } from 'vitest';
import { fallbackServerUrl, isValidServerHost, parsePrintedServerUrl, serverCommandArgs } from '../src/serverUrl';

const defaults = { port: null, host: '', https: false };

describe('server URL parsing', () => {
    it.each([
        ['Local: https://localhost:3000/', 'https://localhost:3000', 3000],
        ['http://127.0.0.1:4000', 'http://127.0.0.1:4000', 4000],
        ['Local: http://[::1]:3001/', 'http://[::1]:3001', 3001],
        ['Local: https://dev.example:443/app/', 'https://dev.example:443/app/', 443],
    ])('parses %s without rebuilding the URL', (output, url, port) => {
        expect(parsePrintedServerUrl(output)).toMatchObject({ url, port });
    });

    it('prefers the first Local URL and ignores Network links', () => {
        expect(parsePrintedServerUrl('Network: http://10.0.0.1:3000/\nLocal: https://localhost:4443/\nLocal: http://localhost:5000'))
            .toEqual({ url: 'https://localhost:4443', port: 4443, local: true });
    });

    it.each(['http://localhost:0/', 'http://localhost:65536/', 'file://localhost:3000', 'Network: http://10.0.0.1:3000/'])(
        'ignores invalid or non-local output %s', output => {
            expect(parsePrintedServerUrl(output)).toBeNull();
        });
});

describe('server settings validation', () => {
    it.each(['', 'localhost', 'dev.local', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '2001:db8::1'])(
        'accepts host %s', host => expect(isValidServerHost(host)).toBe(true));
    it.each(['--host', 'a b', 'a;echo', 'a&b', 'a|b', '$(id)', '`id`', 'a\nb', 'https://host', 'host:3000', '-host', 'a..b', '[host]'])(
        'rejects host %s', host => expect(isValidServerHost(host)).toBe(false));

    it('builds IPv6 and HTTPS polling URLs with the actual port', () => {
        expect(fallbackServerUrl(4444, { port: 4443, host: '::1', https: true })).toBe('https://[::1]:4444');
        expect(fallbackServerUrl(3000, defaults)).toBe('http://localhost:3000');
    });

    it('does not add npm separator or flags for unset defaults', () => {
        expect(serverCommandArgs('npm', 'dev', defaults)).toEqual(['run', 'dev']);
    });
});
