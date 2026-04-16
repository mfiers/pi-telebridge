# pi-telebridge

A [pi](https://github.com/badlogic/pi-mono) extension that creates a two-way relay between your active pi coding agent session and a Telegram bot. Enable it per-session with `/telegram`, then interact with your session from your phone.

- **Agent → Phone**: Every final assistant response is forwarded to your Telegram chat
- **Phone → Agent**: Your Telegram replies are injected as user messages into the session
- **Voice Messages**: Voice, audio, and video note messages are downloaded and forwarded to the agent for transcription
- **Photos**: Photos are downloaded and forwarded to the agent for viewing/analysis

Both the pi TUI and Telegram inputs coexist — you can use either at any time.

## Install

```bash
pi install npm:pi-telebridge
```

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram and copy the token
2. In pi, run `/telegram setup` (or `/telegram setup work` to give it a name)
3. Enter your bot token when prompted
4. Send any message to your bot on Telegram — this links your chat ID
5. Done! Config is saved to `~/.pi/agent/telebridge.json`

Repeat for each bot you want (e.g. `/telegram setup home`).

### Environment Variables (optional)

Environment variables apply to the `default` bot only and take priority over the config file:

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

## Commands

| Command | Description |
|---------|-------------|
| `/telegram` | Toggle relay on/off; if multiple bots configured, prompts you to pick one |
| `/telegram <name>` | Activate a named bot and enable relay (e.g. `/telegram work`) |
| `/telegram setup [name]` | Guided setup for a named bot (default name: `default`) |
| `/telegram list` | List all configured bots |
| `/telegram remove <name>` | Remove a named bot |
| `/telegram status` | Show active bot, chat ID, and relay state |

When the relay is enabled:
- A **📡 TG:name** indicator appears in the pi footer
- Every assistant response is forwarded to your Telegram chat
- Messages you send to the bot are injected into the pi session
- Voice/audio messages are saved to `~/.pi/agent/voice_messages/` and forwarded as `[Voice message received: <path>]`
- Photos are saved to `~/.pi/agent/photo_messages/` and forwarded as `[Photo received: <path>]`
- If the agent is idle, your message starts a new turn; if busy, it's queued as a follow-up

## Multiple bots

You can configure as many named bots as you like. Each has its own token and linked chat ID:

```
/telegram setup work    # configure "work" bot
/telegram setup home    # configure "home" bot
```

Switch between them at any time — even across different pi sessions:

```
/telegram work          # activate work bot + enable relay
/telegram home          # activate home bot + enable relay
```

Config is stored in `~/.pi/agent/telebridge.json`:

```json
{
  "bots": {
    "work": { "botToken": "...", "chatId": 111111 },
    "home": { "botToken": "...", "chatId": 222222 }
  }
}
```

The config file only stores credentials. Which bot is active is **per-session in-memory state** — two pi sessions can run different bots simultaneously without interfering with each other.

Existing single-bot configs (`{ "botToken": "...", "chatId": ... }`) are automatically migrated to the multi-bot format on first use, stored under the name `default`.

## Multiple sessions

Only one pi session can poll a given Telegram bot token at a time — this is a Telegram API constraint. If two sessions try to use the **same** bot token, the second one takes over ("last writer wins"):

- The **second session claims the bot** and becomes the active relay
- The **first session is evicted** silently: its relay is disconnected
- When you return to the first session, a warning is shown:

  > ⚠️ Telegram relay was taken over by another session. Run /telegram to reconnect.

If you want two sessions active simultaneously, use **two different bot tokens** (e.g. `/telegram work` in one session, `/telegram home` in another).

Eviction is coordinated via a lock file at `~/.pi/agent/telebridge.lock`.

## Security

- Only messages from your configured `chatId` are accepted; all others are silently ignored
- Bot tokens and chat IDs are stored locally in `~/.pi/agent/telebridge.json`

## License

MIT
