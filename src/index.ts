import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	loadConfig,
	saveConfig,
	resolveToken,
	resolveChatId,
	type MultiBotConfig,
} from "./config.js";
import {
	startBot,
	stopBot,
	getBot,
	setAllowedChatId,
	setIncomingMessageHandler,
	setIncomingVoiceHandler,
	setIncomingPhotoHandler,
	waitForChatId,
	sendText,
	sendTyping,
	sendPhotoFromBase64,
	sendPhotoFromFile,
} from "./bot.js";
import { markdownToTelegramHtml, splitForTelegram } from "./formatter.js";

// Reserved subcommand names — these are never treated as bot names
const RESERVED = new Set(["setup", "status", "list", "remove", "off", "on"]);

const TELEGRAM_BRIEF_INSTRUCTION = [
	"The user is reading this on a phone via Telegram.",
	"Be very concise: short paragraphs, no big code blocks unless asked.",
	"Summarize actions taken rather than showing full output.",
	"Use plain language, skip formatting-heavy content.",
].join(" ");

export default function (pi: ExtensionAPI) {
	let relayEnabled = false;
	let activeBotName: string | null = null;
	let chatId: number | null = null;
	let botToken: string | null = null;
	let lastMessageFromTelegram = false;

	// ── Helpers ─────────────────────────────────────────────────

	function isSetUp(): boolean {
		return getBot() !== null && chatId !== null;
	}

	function getOrCreateConfig(): MultiBotConfig {
		return loadConfig() ?? { bots: {} };
	}

	// ── Setup Flow ───────────────────────────────────────────────

	async function runSetup(ctx: ExtensionCommandContext, name: string): Promise<boolean> {
		// 1. Resolve bot token — env var only applies to "default"
		const existingToken = resolveToken(name);
		let token = existingToken;
		if (!token) {
			const input = await ctx.ui.input(
				`Enter Telegram bot token for "${name}" (from @BotFather):`
			);
			if (!input?.trim()) {
				ctx.ui.notify("Setup cancelled — no token provided", "warning");
				return false;
			}
			token = input.trim();
		}

		// 2. Start bot temporarily to discover chat ID
		ctx.ui.notify(`Starting bot "${name}"...`, "info");
		try {
			await startBot(token);
		} catch (err: any) {
			ctx.ui.notify(`Failed to start bot: ${err.message}`, "error");
			return false;
		}

		// 3. Resolve chat ID — env var only applies to "default"
		let id = resolveChatId(name);
		if (!id) {
			ctx.ui.notify(
				`Send any message to your "${name}" bot on Telegram to link your chat...`,
				"info"
			);
			id = await waitForChatId();
			ctx.ui.notify(`Chat ID discovered: ${id}`, "info");
		}

		// 4. Persist to config
		const config = getOrCreateConfig();
		config.bots[name] = { botToken: token, chatId: id };
		saveConfig(config);

		// 5. Wire up the incoming handler and mark active
		botToken = token;
		chatId = id;
		activeBotName = name;
		setAllowedChatId(id);
		wireIncomingHandler(ctx);

		ctx.ui.notify(`✅ Bot "${name}" configured! Chat ID: ${id}`, "info");
		return true;
	}

	// ── Activate a named bot ─────────────────────────────────────

	/**
	 * Switch to a named bot: stop any running bot, start the new one, enable relay.
	 * If the bot isn't configured yet, guide the user through setup first.
	 */
	async function activateBot(ctx: ExtensionCommandContext, name: string): Promise<void> {
		const config = getOrCreateConfig();
		const entry = config.bots[name];

		if (!entry) {
			ctx.ui.notify(
				`No bot named "${name}". Run \`/telegram setup ${name}\` to configure it.`,
				"warning"
			);
			return;
		}

		// If we're switching away from the current bot, notify the old chat
		if (relayEnabled && chatId) {
			await sendText(chatId, `📴 Switching to "${name}" bot...`);
		}

		// Stop existing bot
		await stopBot();
		relayEnabled = false;
		if (ctx.hasUI) ctx.ui.setStatus("telebridge", undefined);

		// Start the new bot
		ctx.ui.notify(`Starting bot "${name}"...`, "info");
		try {
			await startBot(entry.botToken);
		} catch (err: any) {
			ctx.ui.notify(`Failed to start bot "${name}": ${err.message}`, "error");
			return;
		}

		// Update state
		botToken = entry.botToken;
		chatId = entry.chatId;
		activeBotName = name;
		saveConfig(config);
		setAllowedChatId(chatId);
		wireIncomingHandler(ctx);

		// Enable relay
		await enableRelay(ctx);
	}

	// ── Incoming Message Handler ─────────────────────────────────

	function wireIncomingHandler(ctx: ExtensionContext) {
		setIncomingMessageHandler((_incomingChatId, text) => {
			if (!relayEnabled) {
				sendText(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					`📱 Telegram: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`,
					"info"
				);
			}
			lastMessageFromTelegram = true;
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		});

		setIncomingVoiceHandler((_incomingChatId, filePath, duration) => {
			if (!relayEnabled) {
				sendText(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(`🎤 Telegram: voice message (${duration}s) saved to ${filePath}`, "info");
			}
			lastMessageFromTelegram = true;
			const text = `[Voice message received: ${filePath}]`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		});

		setIncomingPhotoHandler((_incomingChatId, filePath, caption) => {
			if (!relayEnabled) {
				sendText(_incomingChatId, "⚠️ Relay is disabled. Enable with /telegram in pi.");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(`📷 Telegram: photo received → ${filePath}`, "info");
			}
			lastMessageFromTelegram = true;
			const text = caption
				? `[Photo received: ${filePath}] ${caption}`
				: `[Photo received: ${filePath}]`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
			} else {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			}
		});
	}

	// ── Relay Toggle ─────────────────────────────────────────────

	async function enableRelay(ctx: ExtensionContext) {
		relayEnabled = true;
		pi.appendEntry("telebridge-state", { enabled: true, bot: activeBotName });
		if (ctx.hasUI) {
			const label = activeBotName ? `📡 TG:${activeBotName}` : "📡 TG";
			ctx.ui.setStatus("telebridge", ctx.ui.theme.fg("success", label));
			ctx.ui.notify(
				`🟢 Telegram relay enabled${activeBotName ? ` (${activeBotName})` : ""}`,
				"info"
			);
		}
		if (chatId) {
			await sendText(chatId, "📡 Connected to pi session");
		}
	}

	async function disableRelay(ctx: ExtensionContext) {
		relayEnabled = false;
		pi.appendEntry("telebridge-state", { enabled: false });
		if (ctx.hasUI) {
			ctx.ui.setStatus("telebridge", undefined);
			ctx.ui.notify("🔴 Telegram relay disabled", "info");
		}
		if (chatId) {
			await sendText(chatId, "📴 Disconnected from pi session");
		}
	}

	// ── Command Handler ──────────────────────────────────────────

	pi.registerCommand("telegram", {
		description: "Telegram relay — /telegram <name> | setup [name] | list | remove <name> | status",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "";

			// ── /telegram setup [name] ──────────────────────────────
			if (sub === "setup") {
				const name = parts[1] ?? "default";
				await runSetup(ctx, name);
				return;
			}

			// ── /telegram list ──────────────────────────────────────
			if (sub === "list") {
				const config = loadConfig();
				if (!config || Object.keys(config.bots).length === 0) {
					ctx.ui.notify("No bots configured. Run `/telegram setup <name>` to add one.", "info");
					return;
				}
				const lines = Object.entries(config.bots).map(([name, entry]) => {
					const active = name === activeBotName ? " ← active (this session)" : "";
					const linked = entry.chatId ? `chat ${entry.chatId}` : "no chat linked";
					return `  ${name}: ${linked}${active}`;
				});
				ctx.ui.notify(`Configured bots:\n${lines.join("\n")}`, "info");
				return;
			}

			// ── /telegram remove <name> ─────────────────────────────
			if (sub === "remove") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify("Usage: /telegram remove <name>", "warning");
					return;
				}
				const config = getOrCreateConfig();
				if (!config.bots[name]) {
					ctx.ui.notify(`No bot named "${name}".`, "warning");
					return;
				}
				// Stop if this is the running bot
				if (activeBotName === name) {
					if (relayEnabled && chatId) {
						await sendText(chatId, "📴 Bot removed from pi.");
					}
					await stopBot();
					relayEnabled = false;
					activeBotName = null;
					chatId = null;
					botToken = null;
					if (ctx.hasUI) ctx.ui.setStatus("telebridge", undefined);
				}
				delete config.bots[name];
				saveConfig(config);
				ctx.ui.notify(`🗑 Bot "${name}" removed.`, "info");
				return;
			}

			// ── /telegram status ────────────────────────────────────
			if (sub === "status") {
				const botRunning = getBot() !== null;
				const config = loadConfig();
				const botCount = config ? Object.keys(config.bots).length : 0;
				const lines = [
					`Bot: ${botRunning ? `✅ running (${activeBotName ?? "?"})` : "❌ stopped"}`,
					`Chat ID: ${chatId ?? "not set"}`,
					`Relay: ${relayEnabled ? "🟢 enabled" : "🔴 disabled"}`,
					`Configured bots: ${botCount}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// ── /telegram <name> — activate a named bot ─────────────
			if (sub && !RESERVED.has(sub)) {
				await activateBot(ctx, sub);
				return;
			}

			// ── /telegram (no args) — toggle relay ──────────────────
			if (!sub) {
				if (!isSetUp()) {
					const config = loadConfig();
					const names = config ? Object.keys(config.bots) : [];
					if (names.length === 0) {
						// Nothing configured yet — run default setup
						const ok = await runSetup(ctx, "default");
						if (!ok) return;
						await enableRelay(ctx);
					} else if (names.length === 1) {
						// Exactly one bot — activate it automatically
						await activateBot(ctx, names[0]);
					} else {
						// Multiple bots — tell the user to pick
						ctx.ui.notify(
							`Multiple bots configured. Activate one with:\n${names.map(n => `  /telegram ${n}`).join("\n")}`,
							"info"
						);
					}
					return;
				}
				// Bot already running — toggle relay
				if (relayEnabled) {
					await disableRelay(ctx);
				} else {
					await enableRelay(ctx);
				}
				return;
			}

			// Fallthrough: unknown subcommand
			ctx.ui.notify(
				`Usage:\n` +
				`  /telegram <name>        — activate named bot\n` +
				`  /telegram setup [name]  — configure a bot\n` +
				`  /telegram list          — list configured bots\n` +
				`  /telegram remove <name> — remove a bot\n` +
				`  /telegram status        — show current state\n` +
				`  /telegram               — toggle relay`,
				"info"
			);
		},
	});

	// ── TUI input mirror ─────────────────────────────────────────

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			lastMessageFromTelegram = false;
			if (relayEnabled && chatId && event.text?.trim()) {
				await sendText(chatId, `💻 ${event.text.trim()}`);
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!relayEnabled || !lastMessageFromTelegram) return;
		return {
			systemPrompt: event.systemPrompt + "\n\n" + TELEGRAM_BRIEF_INSTRUCTION,
		};
	});

	// ── Session Events ───────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		if (relayEnabled && getBot() === null && ctx.hasUI) {
			ctx.ui.notify(
				"⚠️ Telegram relay was taken over by another session. Run /telegram to reconnect.",
				"warning"
			);
		}
		await stopBot();
		relayEnabled = false;
		activeBotName = null;
		lastMessageFromTelegram = false;
		if (ctx.hasUI) ctx.ui.setStatus("telebridge", undefined);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		if (relayEnabled && chatId) {
			await sendText(chatId, "📴 Session switching...");
		}
		await stopBot();
		relayEnabled = false;
		activeBotName = null;
		lastMessageFromTelegram = false;
		if (ctx.hasUI) ctx.ui.setStatus("telebridge", undefined);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await stopBot();
		relayEnabled = false;
		activeBotName = null;
		lastMessageFromTelegram = false;
		if (ctx.hasUI) ctx.ui.setStatus("telebridge", undefined);
	});

	pi.on("session_shutdown", async () => {
		if (relayEnabled && chatId) {
			await sendText(chatId, "📴 pi session ended");
		}
		await stopBot();
	});

	// ── Agent → Telegram (outgoing) ──────────────────────────────

	pi.on("agent_start", async () => {
		if (relayEnabled && chatId) {
			await sendTyping(chatId);
		}
	});

	pi.on("agent_end", async (event) => {
		if (!relayEnabled || !chatId) return;
		lastMessageFromTelegram = false;

		const messages = event.messages ?? [];

		// Collect images from tool results
		const imagesToSend: Array<
			| { type: "base64"; mediaType: string; data: string }
			| { type: "file"; path: string }
		> = [];
		for (const msg of messages) {
			if (msg.role !== "toolResult") continue;
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const block of content) {
				if (block.type === "image") {
					if (block.source?.type === "base64") {
						imagesToSend.push({
							type: "base64",
							mediaType: block.source.mediaType ?? "image/png",
							data: block.source.data,
						});
					} else if (block.data) {
						imagesToSend.push({
							type: "base64",
							mediaType: block.mimeType ?? "image/png",
							data: block.data,
						});
					}
				}
			}
		}

		// Extract last assistant text
		let assistantText = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					assistantText = msg.content;
				} else if (Array.isArray(msg.content)) {
					assistantText = msg.content
						.filter((block: any) => block.type === "text")
						.map((block: any) => block.text)
						.join("\n");
				}
				break;
			}
		}

		if (assistantText.trim()) {
			const html = markdownToTelegramHtml(assistantText);
			const chunks = splitForTelegram(html);
			for (const chunk of chunks) {
				try {
					await sendText(chatId!, chunk, "HTML");
				} catch {
					try {
						await sendText(chatId!, assistantText.slice(0, 4096));
					} catch {
						// Give up silently
					}
				}
			}
		}

		for (const img of imagesToSend) {
			if (img.type === "base64") {
				await sendPhotoFromBase64(chatId!, img.data, img.mediaType);
			} else {
				await sendPhotoFromFile(chatId!, img.path);
			}
		}
	});
}
