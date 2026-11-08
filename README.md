# RoLink

RoLink connects AI agents to a live Roblox Studio through the [Model Context Protocol](https://modelcontextprotocol.io). An agent can look at a place, build, script, run the game and test it, and publish assets, the same way a person would. Changes appear in Studio at once and each one is a single undo step.

## Status

**Tested with automated mocks only.** The test suites use a mock Studio plugin, a Lune harness that simulates Roblox instances, a fake Open Cloud and fake dialogs. Real Roblox Studio and the live Open Cloud API have not been verified end to end. Expect rough edges. Known gaps are listed in [docs/guide/limits-and-known-gaps.md](docs/guide/limits-and-known-gaps.md).

## Features

- **File mirror.** The whole place appears as files. Agents read and edit them with normal file tools, and edits reach Studio within a second. Studio changes come back.
- **Build tool.** JSON specs with local coordinates, repeats, mirroring, spans and CSG.
- **Scripts.** Create, search, outline and syntax-check. Rojo-style project sync for repositories.
- **Play-tests by script.** Start a test, run scenarios with helpers, read Output with stack traces, profile. Multiplayer with up to 8 clients.
- **Screenshots** of the 3D viewport from named angles (Windows).
- **Import** OBJ, glTF, GLB and STL models, FBX through upload, and glTF skeletal animation.
- **Creator Store quarantine.** Assets arrive with scripts disabled, and a report flags suspicious code.
- **Publishing server** for sounds, images, animations and places through Open Cloud, and data store access, with confirmation steps.
- **Built-in guide.** The `guide` tool serves a topic for every subject, so any agent can look up exact formats.

## Install

You need Node.js 20 or newer and Roblox Studio.

```bash
git clone <this repository>
cd RoLink/server
npm install
npm run build
cd ..
node plugin/build.mjs --install
```

`--install` copies the plugin to Studio's plugins folder on Windows. On macOS, run `node plugin/build.mjs` and copy `plugin/dist/RoLink.rbxmx` to `~/Documents/Roblox/Plugins`. Restart Studio.

The first time, Studio may ask to allow the plugin's HTTP access to `127.0.0.1` and script injection. Both are needed.

The server downloads the Roblox API dump from a public GitHub tracker on first start and caches it.

Optional publishing server:

```bash
cd publisher
npm install
npm run build
```

### Connect your MCP client

Use absolute paths.

**Claude Code**

```bash
claude mcp add rolink -- node /absolute/path/to/RoLink/server/dist/index.js
```

**Cursor** (`.cursor/mcp.json`), and other clients with the same config format:

```json
{
  "mcpServers": {
    "rolink": {
      "command": "node",
      "args": ["/absolute/path/to/RoLink/server/dist/index.js"]
    }
  }
}
```

**ChatGPT and others.** RoLink is a local stdio MCP server. Any client that can launch a local stdio server works with the command above. A client that only supports remote MCP servers would need a stdio-to-HTTP bridge, which this project does not include and has not tested.

Publishing server (optional). Keep the key in your client's configuration, never in the repository:

```json
{
  "mcpServers": {
    "rolink-publish": {
      "command": "node",
      "args": ["/absolute/path/to/RoLink/publisher/dist/index.js"],
      "env": { "ROBLOX_PUBLISH_API_KEY": "your-key", "ROBLOX_CREATOR_USER_ID": "your-user-id" }
    }
  }
}
```

See [docs/guide/install-and-connect.md](docs/guide/install-and-connect.md) and [publisher/README.md](publisher/README.md).

## Quick start

Open a place in Studio and ask your agent, for example:

> Call `status`, then start the mirror in a new folder, and add a door to the house that opens with a ProximityPrompt. Test it with a play-test.

The agent should call `guide()` before unfamiliar work. To read the documentation yourself, start at [docs/guide/overview.md](docs/guide/overview.md).

## Safety

- The bridge listens on `127.0.0.1` only, and refuses browser requests.
- **An agent connected to RoLink can run arbitrary code in Studio.** Save your work and use version control. Tools do not save the place for you.
- Instance names, scripts, Creator Store assets, Output and data store values are untrusted content. Agents are told to treat them as data, but no tool can guarantee that.
- Free models can contain malicious scripts. The quarantine scanner recognises known patterns only, so review scripts yourself.
- Confirmation phrases for asset uploads are a soft agreement. Native OS dialogs guard live changes (publishing a place, restarting servers, changing data stores), but cannot stop software running under your own user account.
- Give API keys only the permissions and experiences you need.

Details: [docs/guide/security-and-trust.md](docs/guide/security-and-trust.md).

## Disclaimer

**You are responsible for everything published through this software, including anything an agent chose for you.** That covers holding the rights to it and complying with Roblox's terms and community standards. Roblox can remove assets and penalise accounts, and rights holders can file claims. An automatic copyright check that finds nothing does not mean a work is free to use. This software is provided as is, without warranty of any kind, and the authors accept no liability for what you publish or for loss of work or data.

This project is not affiliated with or endorsed by Roblox Corporation.

## Development

```bash
cd server
npx tsc --noEmit
npm run build
npm run test:unit
npm run test:plugin
node test/e2e.mjs

cd ../publisher
npm test
```

`npm run test:plugin` needs [Lune](https://github.com/lune-org/lune) on the PATH, or in `tools/bin/`.

## Русский

RoLink подключает ИИ-агентов к запущенному Roblox Studio через MCP. Агент видит плейс как файлы, строит, пишет скрипты, запускает и проверяет игру, публикует ассеты. Каждое изменение появляется в Studio сразу и отменяется одним Ctrl+Z.

**Статус:** проверено только автоматическими тестами на моках. В настоящем Roblox Studio и с живым Open Cloud полной проверки ещё не было.

**Установка:** нужны Node.js 20+ и Roblox Studio. В папке `server` выполните `npm install` и `npm run build`, затем из корня репозитория `node plugin/build.mjs --install`. Добавьте в свой MCP-клиент команду `node /полный/путь/RoLink/server/dist/index.js`. Откройте плейс в Studio и разрешите плагину доступ к `127.0.0.1` и изменение скриптов.

**Важно:** подключённый агент может выполнять в Studio любой код, поэтому сохраняйте работу и используйте контроль версий. **Вы сами отвечаете за всё, что публикуется через эту программу, включая то, что выбрал агент**, в том числе за права на контент и соблюдение правил Roblox. Программа предоставляется как есть, без каких-либо гарантий.

Документация на английском: [docs/guide/overview.md](docs/guide/overview.md).
