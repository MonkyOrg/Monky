// Public contracts of BotClient: what a bot declares and what its handlers receive.
// The package entry point re-exports every type here.
import type { KeyObject } from 'node:crypto';
import type {
  BotCapability,
  BotForm,
  BotFormValues,
  BotLocale,
  BotMessageContent,
  BotPublishedMessageContent,
  BotScreen,
  BotScreenCreate,
  BotSelector,
  BotSelectorCreate,
  BotSelectorRespondedPayload,
  BotSettingsContext,
  CommandAudioPreviewMimeType,
  CommandAutocompleteChoice,
  CommandAutocompletePage,
  CommandCallerContext,
  CommandLocalizations,
  CommandOption,
  CommandValues,
  CommandVoiceRequirement,
  LiveAction,
  LiveActionCreate,
  LocalCapabilityId,
  LocalWirePreviewResult,
  SelectionChoice,
  SoundDownloadRequest,
  SoundDownloadResult,
} from '@monky/shared';

export interface BotOptions {
  /** Explicit request, not a grant. Each server administrator approves a subset. */
  requestedCapabilities: BotCapability[];
  serverUrl?: string;
  token?: string;
  /** Ed25519 public key in hex (DER/SPKI), used for TOFU binding. */
  publicKey: string;
  /**
   * Ed25519 private key matching `publicKey` (PEM or KeyObject). With it the bot
   * proves it holds the key when signing in, so a leaked token alone cannot
   * impersonate it. Defaults to the identity of the bot runtime CLI. A bot that
   * proved its key once on a server must keep proving it there.
   */
  privateKey?: string | KeyObject;
  autoReconnect?: boolean;
  /** Optional profile to synchronize, including already-added bot accounts. */
  name?: string;
  /** Image bytes encoded as base64 or a data URI; null removes the previous photo. */
  avatarBase64?: string | null;
  /** Private JSON file for authenticated marketplace registrations; survives close/restart. */
  registrationFile?: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  localizations?: CommandLocalizations;
  options?: CommandOption[];
  downloadsSound?: boolean;
  voiceRequirement?: CommandVoiceRequirement;
  localCapabilities?: LocalCapabilityId[];
  autocomplete?: (
    ctx: CommandAutocompleteContext
  ) => CommandAutocompleteChoice[] | CommandAutocompletePage | Promise<CommandAutocompleteChoice[] | CommandAutocompletePage>;
  audioPreview?: (
    ctx: CommandAudioPreviewContext
  ) => CommandAudioPreviewResponse | Promise<CommandAudioPreviewResponse>;
  handler: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandAutocompleteContext extends CommandCallerContext {
  /** Server-remapped correlation for this live interaction, not the UI request ID. */
  requestId: string;
  commandName: string;
  query: string;
  /** Zero-based page. Legacy searches start at zero. */
  page: number;
  cursor?: string;
  optionName: string;
  args: CommandValues;
  locale: BotLocale;
  serverId: string;
  readonly settings: BotSettingsContext;
  signal: AbortSignal;
}

export interface CommandAudioPreviewContext extends CommandCallerContext {
  /** Server-remapped correlation for this live interaction, not the UI request ID. */
  requestId: string;
  commandName: string;
  resourceId: string;
  serverId: string;
  locale: BotLocale;
  optionName: string;
  /** Aborted on cancellation, timeout, disconnection or completion. */
  signal: AbortSignal;
  readonly settings: BotSettingsContext;
}

export interface CommandAudioPreviewData {
  bytes: Uint8Array;
  mimeType: CommandAudioPreviewMimeType;
}

export type CommandAudioPreviewResponse = CommandAudioPreviewData | LocalWirePreviewResult;

export interface CommandContext {
  invocationId: string;
  botId: string;
  commandName: string;
  channelId: string;
  invokerId: string;
  invokerSessionId: string;
  /** Voice room captured when the invocation began; use getVoiceChannel after awaits. */
  invokerVoiceChannelId: string | null;
  /** Revalidate this exact human session's current room with the server. */
  getVoiceChannel: () => Promise<string | null>;
  invokerNickname: string;
  serverId: string;
  locale: BotLocale;
  /** Immutable preferences captured for this invocation, including subsequent prompts. */
  readonly settings: BotSettingsContext;
  /** Named, typed values: integer and boolean options are not strings. */
  args: CommandValues;
  /** Aborted on cancellation, timeout, disconnection or completion. */
  signal: AbortSignal;
  /** Private response in the caller's chat. */
  reply: (content: BotMessageContent) => void;
  replyEphemeral: (content: BotMessageContent) => void;
  /** Explicitly publish a result to everyone allowed into the channel. */
  publish: (content: BotPublishedMessageContent) => void;
  /** Wait for a private form. Returns null if the interaction ends/cancels. */
  prompt: (form: BotForm) => Promise<BotFormValues | null>;
  /** Ask one private choice; buttons submit immediately, dropdowns require confirmation. */
  choose: (choice: BotChoice) => Promise<string | null>;
  /** Request one caller-authorized local soundboard download; never downloads on the bot. */
  downloadSound: (request: SoundDownloadRequest) => Promise<SoundDownloadResult | null>;
  /** Publish durable channel controls, independent of this invocation's lifetime. */
  createSelector: (input: Omit<BotSelectorCreate, 'channelId' | 'invokerId' | 'invocationId'>) => Promise<BotSelector>;
  createLiveAction: (input: Omit<LiveActionCreate, 'channelId' | 'invocationId'>) => Promise<LiveAction>;
  /** Open a shared miniapp in the caller's current voice room, independent of this command's lifetime. */
  createScreen: (input: Omit<BotScreenCreate, 'channelId' | 'invocationId'>) => Promise<BotScreen>;
}

export interface BotChoice {
  title: string;
  description?: string;
  choices: SelectionChoice[];
  presentation?: 'dropdown' | 'buttons';
  submitLabel?: string;
}

export type BotSelectorResponseEvent = Omit<BotSelectorRespondedPayload, 'settings'>;

export interface BotSelectorResponseContext {
  readonly serverId: string;
  readonly settings: BotSettingsContext;
}

export interface ServeOptions {
  name: string;
  description?: string;
  /** Base64 image or data URI. Remote image URLs are not supported. */
  icon?: string;
  port?: number;
  host?: string;
  /** Public hostname/IP, without a scheme or port. */
  publicHost?: string;
  /**
   * Public origin announced in the manifest instead of `publicHost` and
   * `port`, such as `https://bot.example.com` behind a TLS reverse proxy.
   * Monky servers post the token to `<publicUrl>/register`, so HTTPS keeps it
   * encrypted on the way. Only an origin: no path, query or fragment.
   */
  publicUrl?: string;
}
