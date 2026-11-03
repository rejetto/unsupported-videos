const assert = require('node:assert/strict')
const test = require('node:test')

test('configured extensions use the video icon without replacing custom icons', t => {
    const handlers = {}
    global.HFS = {
        React: {},
        getPluginConfig: () => ({ extensions: 'avi,mkv' }),
        getPluginPublic: () => '/',
        onEvent: (name, handler) => handlers[name] = handler,
    }
    t.after(() => delete global.HFS)
    require('../dist/public/main')
    const entries = [
        { ext: 'avi' },
        { ext: 'txt' },
        { ext: 'mkv', icon: 'custom' },
    ]

    handlers.newListEntries({ entries })

    assert.deepEqual(entries.map(entry => entry.icon), ['video', undefined, 'custom'])
})
