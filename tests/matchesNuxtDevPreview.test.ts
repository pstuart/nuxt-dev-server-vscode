import { describe, expect, it } from 'vitest';
import { matchesNuxtDevPreview } from '../src/processLogic';

describe('matchesNuxtDevPreview substring edge cases', () => {
    it.each([
        'my-nuxt-app dev',
        'node /workspace/node_modules/.bin/my-nuxt-app dev',
        'node /workspace/node_modules/.bin/nuxt-cli dev',
        'node /workspace/node_modules/.bin/nuxify dev',
        'nuxtd dev',
        'node /workspace/node_modules/.bin/nuxt-preview dev',
    ])('rejects executables containing nuxt as a substring but not named nuxt: %s', command => {
        expect(matchesNuxtDevPreview(command)).toBe(false);
    });

    it('accepts a bare nuxt executable even when the path contains nuxt', () => {
        expect(matchesNuxtDevPreview(
            'node /workspace/node_modules/.bin/nuxt dev'
        )).toBe(true);
        expect(matchesNuxtDevPreview(
            'node /opt/nuxt-tools/node_modules/.bin/nuxi preview'
        )).toBe(true);
    });
});
