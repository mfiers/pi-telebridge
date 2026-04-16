import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface BotEntry {
	botToken: string;
	chatId: number | null;
}

export interface MultiBotConfig {
	bots: Record<string, BotEntry>;
}

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "telebridge.json");

// ── Migration ───────────────────────────────────────────────

/**
 * Migrate legacy single-bot config  { botToken, chatId }  to the multi-bot
 * format  { bots: { default: { botToken, chatId } } }.
 * Returns null if the file doesn't exist or is unparseable.
 */
function loadAndMigrate(): MultiBotConfig | null {
	let raw: string;
	try {
		raw = fs.readFileSync(CONFIG_FILE, "utf-8");
	} catch {
		return null;
	}

	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}

	// Already multi-bot format
	if (data.bots && typeof data.bots === "object") {
		return { bots: data.bots };
	}

	// Legacy single-bot format
	if (typeof data.botToken === "string") {
		const migrated: MultiBotConfig = {
			bots: {
				default: {
					botToken: data.botToken,
					chatId: typeof data.chatId === "number" ? data.chatId : null,
				},
			},
		};
		// Persist the migrated format right away
		saveConfig(migrated);
		return migrated;
	}

	return null;
}

export function loadConfig(): MultiBotConfig | null {
	return loadAndMigrate();
}

export function saveConfig(config: MultiBotConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ── Env-var helpers (env takes priority over config file) ───

export function resolveToken(botName?: string): string | null {
	// For the "default" bot (or when no name specified), env var takes priority
	if (!botName || botName === "default") {
		const envToken = process.env.TELEGRAM_BOT_TOKEN;
		if (envToken) return envToken;
	}

	const config = loadConfig();
	if (!config) return null;
	const names = Object.keys(config.bots);
	const name = botName ?? (names.length === 1 ? names[0] : "default");
	return config.bots[name]?.botToken ?? null;
}

export function resolveChatId(botName?: string): number | null {
	// For the "default" bot (or when no name specified), env var takes priority
	if (!botName || botName === "default") {
		const envChatId = process.env.TELEGRAM_CHAT_ID;
		if (envChatId) {
			const parsed = parseInt(envChatId, 10);
			if (!isNaN(parsed)) return parsed;
		}
	}

	const config = loadConfig();
	if (!config) return null;
	const names = Object.keys(config.bots);
	const name = botName ?? (names.length === 1 ? names[0] : "default");
	return config.bots[name]?.chatId ?? null;
}
