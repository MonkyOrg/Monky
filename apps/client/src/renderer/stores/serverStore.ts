import { AttachmentStorageInfo, ChannelSummary, DEFAULT_PERMISSIONS, Permission, Role, ServerDetails, SlashCommand, TurnAvailability, UserRoleSummary, UserSummary, VoiceMode, VoiceRestrictions, hasPermission } from '@monky/shared';
import { appEvents, EventBus } from '../core/EventBus';
import { createActiveProxy } from '../core/activeProxy';
import { clientLog } from '../core/ClientLogService';

export class ServerStore {
  /**
   * Where change notifications go. Only the server being looked at points at
   * the app-wide bus; the others hold a silent one so their updates stay
   * invisible until the user switches to them (#400).
   */
  public bus: EventBus = appEvents;
  public serverDetails: ServerDetails | null = null;
  public currentUser: UserSummary | null = null;
  public voiceRestrictions: VoiceRestrictions = { serverMuted: false, serverDeafened: false };
  public activeTextChannelId: string | null = null;
  public roles: Role[] = [];
  public userRoles: UserRoleSummary[] = [];
  public ownerId: string | null = null;
  public myPermissions: number = 0;
  // Everyone who has ever connected (keyed by userId), so offline users remain
  // mentionable in chat (#14). Kept separate from the live members list.
  public knownMembers: Map<string, UserSummary> = new Map();
  /** Slash commands registered by online bots (#569). */
  public slashCommands: SlashCommand[] = [];

  public setServerDetails(details: ServerDetails, currentUser: UserSummary): void {
    clientLog.info('SERVER_HOST', `Server details received: "${details.name}"`, {
      channels: details.channels.length,
      members: details.members.length,
      turnEnabled: details.turnEnabled,
    });
    // The server sends one entry per live connection (#309). The member list is
    // per person, so it holds a collapsed copy — the untouched original still
    // feeds the per-session voice lists.
    this.serverDetails = { ...details, members: ServerStore.dedupeMembers(details.members) };
    this.currentUser = currentUser;
    this.roles = details.roles ?? [];
    this.userRoles = details.userRoles ?? [];
    this.ownerId = details.ownerId ?? null;
    this.myPermissions = details.myPermissions ?? 0;

    // Seed the known-members map from the persisted list (falling back to the
    // live members), then make sure the live members and self are present.
    this.knownMembers = new Map();
    const seed = details.knownMembers && details.knownMembers.length > 0 ? details.knownMembers : details.members;
    for (const m of seed) this.knownMembers.set(m.id, m);
    for (const m of details.members) this.rememberMember(m);
    this.rememberMember(currentUser);

    // Set active text channel if not set
    const textChannels = details.channels.filter((c) => c.type === 'TEXT');
    if (textChannels.length > 0 && !this.activeTextChannelId) {
      this.activeTextChannelId = textChannels[0].id;
    }
    this.bus.emit('server.updated');
  }

  /** Keeps the oldest connection of each person, so the list has one row each (#309). */
  private static dedupeMembers(members: UserSummary[]): UserSummary[] {
    const byUser = new Map<string, UserSummary>();
    for (const member of members) {
      const existing = byUser.get(member.id);
      if (!existing || (member.connectedAt || 0) < (existing.connectedAt || 0)) {
        byUser.set(member.id, member);
      }
    }
    return Array.from(byUser.values());
  }

  /** Upserts a user into the persistent known-members map. */
  private rememberMember(user: UserSummary): void {
    const existing = this.knownMembers.get(user.id);
    // Prefer the most informative record: an online summary should not be
    // overwritten by a stale offline one, but nickname/avatar updates apply.
    if (!existing || user.status !== 'DISCONNECTED' || existing.status === 'DISCONNECTED') {
      this.knownMembers.set(user.id, user);
    }
  }

  /**
   * Returns users that can be mentioned in chat: everyone who has ever
   * connected, online first, then alphabetically. Excludes the current user.
   */
  public getMentionableUsers(): UserSummary[] {
    const list = Array.from(this.knownMembers.values()).filter((u) => u.id !== this.currentUser?.id);
    return list.sort((a, b) => {
      const aOnline = a.status !== 'DISCONNECTED' ? 0 : 1;
      const bOnline = b.status !== 'DISCONNECTED' ? 0 : 1;
      if (aOnline !== bOnline) return aOnline - bOnline;
      return a.nickname.localeCompare(b.nickname);
    });
  }

  /** Updates commands from a COMMANDS_LIST_RESPONSE message (#569). */
  public setSlashCommands(commands: SlashCommand[]): void {
    this.slashCommands = commands;
    this.bus.emit('server.commands_updated');
  }

  /** True when the id refers to this very connection, not just to this person (#309). */
  public isMySession(sessionId?: string): boolean {
    return !!sessionId && sessionId === this.currentUser?.sessionId;
  }

  /** All devices of this identity share the same server policy, even outside voice. */
  public updateVoiceRestrictions(userId: string, restrictions: VoiceRestrictions): void {
    if (!this.currentUser || userId !== this.currentUser.id) return;
    const { serverMuted, serverDeafened } = restrictions;
    if (this.voiceRestrictions.serverMuted === serverMuted && this.voiceRestrictions.serverDeafened === serverDeafened) return;
    this.voiceRestrictions = { serverMuted, serverDeafened };
    this.bus.emit('server.voice_restrictions_updated');
  }

  public setActiveTextChannel(channelId: string): void {
    this.activeTextChannelId = channelId;
    this.bus.emit('channel.selected', channelId);
  }

  public addChannel(channel: ChannelSummary): void {
    if (this.serverDetails) {
      this.serverDetails.channels.push(channel);
      this.sortChannels();
      this.bus.emit('server.updated');
    }
  }

  public removeChannel(channelId: string): void {
    if (this.serverDetails) {
      this.serverDetails.channels = this.serverDetails.channels.filter((c) => c.id !== channelId);
      if (this.activeTextChannelId === channelId) {
        const textChannels = this.serverDetails.channels.filter((c) => c.type === 'TEXT');
        this.activeTextChannelId = textChannels.length > 0 ? textChannels[0].id : null;
      }
      this.bus.emit('server.updated');
    }
  }

  /** Applies an edit to a channel already in the list (#384). */
  public updateChannel(channel: ChannelSummary): void {
    if (!this.serverDetails) return;

    const index = this.serverDetails.channels.findIndex((c) => c.id === channel.id);
    if (index === -1) return;

    this.serverDetails.channels[index] = channel;
    this.bus.emit('server.updated');
  }

  /**
   * Applies a new channel order (#471).
   *
   * Only the positions of channels this client can see are sent, so anything
   * not mentioned is left where it is. Sorting here (rather than in the view)
   * keeps a single source of truth for the order: the list in the store is
   * always the list as it should be shown.
   */
  public applyChannelPositions(positions: Array<{ channelId: string; position: number }>): void {
    if (!this.serverDetails || positions.length === 0) return;

    const byId = new Map(positions.map((p) => [p.channelId, p.position]));
    let changed = false;
    for (const channel of this.serverDetails.channels) {
      const next = byId.get(channel.id);
      if (next !== undefined && next !== channel.position) {
        channel.position = next;
        changed = true;
      }
    }
    if (!changed) return;

    this.sortChannels();
    this.bus.emit('server.updated');
  }

  /**
   * Orders channels the way the server does: by position, falling back to
   * creation time so channels sharing a position keep a stable order (#471).
   */
  private sortChannels(): void {
    this.serverDetails?.channels.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  public updateCurrentUser(user: UserSummary): void {
    // Profile updates arrive without connection fields, so ours are kept (#309).
    this.currentUser = {
      ...user,
      sessionId: user.sessionId ?? this.currentUser?.sessionId,
      connectedAt: user.connectedAt ?? this.currentUser?.connectedAt,
    };
    this.rememberMember(user);
    if (this.serverDetails) {
      const idx = this.serverDetails.members.findIndex((m) => m.id === user.id);
      if (idx >= 0) {
        this.serverDetails.members[idx] = user;
      }
    }
    this.bus.emit('user.updated', user);
  }

  public addMember(user: UserSummary): void {
    this.rememberMember(user);
    if (this.serverDetails) {
      const idx = this.serverDetails.members.findIndex((m) => m.id === user.id);
      if (idx >= 0) {
        this.serverDetails.members[idx] = user;
      } else {
        this.serverDetails.members.push(user);
      }
      this.bus.emit('server.members_updated', this.serverDetails.members);
    }
  }

  public removeMember(userId: string): void {
    if (this.serverDetails) {
      this.serverDetails.members = this.serverDetails.members.filter((m) => m.id !== userId);
      this.bus.emit('server.members_updated', this.serverDetails.members);
    }
  }

  public removeMemberCompletely(userId: string): void {
    this.knownMembers.delete(userId);
    this.removeMember(userId);
  }

  public updateMember(user: UserSummary): void {
    if (user.status === 'DISCONNECTED') {
      this.knownMembers.set(user.id, user);
      this.removeMember(user.id);
    } else {
      this.addMember(user);
    }
  }

  public updateServerMeta(
    name: string,
    hasPassword: boolean,
    allowSoundboard?: boolean,
    iconUrl?: string | null,
    attachmentStorage?: AttachmentStorageInfo,
    maxUsers?: number,
    turnEnabled?: boolean,
    allowEveryoneMention?: boolean,
    allowMessageEdit?: boolean,
    voiceMode?: VoiceMode,
    showRoleBadgesToEveryone?: boolean
  ): void {
    if (this.serverDetails) {
      this.serverDetails.name = name;
      this.serverDetails.hasPassword = hasPassword;
      if (allowSoundboard !== undefined) {
        this.serverDetails.allowSoundboard = allowSoundboard;
      }
      if (iconUrl !== undefined) {
        this.serverDetails.iconUrl = iconUrl;
      }
      if (attachmentStorage !== undefined) {
        this.serverDetails.attachmentStorage = attachmentStorage;
      }
      if (maxUsers !== undefined) {
        this.serverDetails.maxUsers = maxUsers;
      }
      if (turnEnabled !== undefined) {
        this.serverDetails.turnEnabled = turnEnabled;
      }
      if (allowEveryoneMention !== undefined) {
        this.serverDetails.allowEveryoneMention = allowEveryoneMention;
      }
      if (allowMessageEdit !== undefined) {
        this.serverDetails.allowMessageEdit = allowMessageEdit;
      }
      if (voiceMode !== undefined) {
        this.serverDetails.voiceMode = voiceMode;
      }
      if (showRoleBadgesToEveryone !== undefined) {
        this.serverDetails.showRoleBadgesToEveryone = showRoleBadgesToEveryone;
      }
      this.bus.emit('server.updated');
      this.bus.emit('server.meta_updated', this.serverDetails);
    }
  }

  /**
   * Refreshes what the host can do about the relay (#438).
   *
   * Separate from `updateServerMeta` because this is not a setting somebody
   * chose: it is the host reporting a capability that may have changed on its
   * own — switching the relay on installs coturn, and from then on the answer
   * from login is stale.
   */
  public setTurnAvailability(availability: TurnAvailability | undefined): void {
    if (!this.serverDetails || availability === undefined) return;
    clientLog.info('SERVER_HOST', 'TURN availability updated', { availability });
    this.serverDetails.turnAvailability = availability;
    this.bus.emit('server.updated');
    this.bus.emit('server.meta_updated', this.serverDetails);
  }

  public updateRoles(roles: Role[], userRoles: UserRoleSummary[]): void {
    this.roles = roles;
    this.userRoles = userRoles;
    if (this.serverDetails) {
      this.serverDetails.roles = roles;
      this.serverDetails.userRoles = userRoles;
    }
    this.recalculateMyPermissions();
    this.bus.emit('server.roles_updated');
    this.bus.emit('server.updated');
  }

  public getRole(roleId: string): Role | undefined {
    return this.roles.find((role) => role.id === roleId);
  }

  /**
   * The built-in Admin role, which every server has. It is a permission state
   * rather than a user-facing role, so it is hidden from role listings (#265).
   */
  public getAdminRole(): Role | undefined {
    return this.roles.find((role) => this.isAdminRole(role));
  }

  public isAdminRole(role: Role): boolean {
    return role.name === 'Admin';
  }

  /** Roles that should be listed and assigned as regular roles in the UI (#265). */
  public getVisibleRoles(): Role[] {
    return this.roles.filter((role) => !this.isAdminRole(role));
  }

  public getUserRoleIds(userId: string): string[] {
    return this.userRoles.find((entry) => entry.userId === userId)?.roleIds ?? [];
  }

  /**
   * Permissions of any member, resolved the same way the server does it: the
   * owner gets everything, someone with no role falls back to the defaults, and
   * roles otherwise combine bit by bit (PermissionService.getUserPermissions).
   */
  public getUserPermissions(userId: string): number {
    if (this.ownerId && userId === this.ownerId) return 0xFFFFFFFF;
    const roleIds = new Set(this.getUserRoleIds(userId));
    const roles = this.roles.filter((role) => roleIds.has(role.id));
    return roles.length === 0
      ? DEFAULT_PERMISSIONS
      : roles.reduce((bits, role) => bits | role.permissions, 0);
  }

  public getChannel(channelId: string): ChannelSummary | undefined {
    return this.serverDetails?.channels.find((c) => c.id === channelId);
  }

  public getUserRoles(userId: string): Role[] {
    const roleIds = new Set(this.getUserRoleIds(userId));
    return this.roles.filter((role) => roleIds.has(role.id)).sort((a, b) => b.position - a.position);
  }

  /**
   * Highest role position held by a user, used to order the member list in the
   * sidebar according to the role ranking defined by drag-and-drop (#262).
   * Users with no role rank last.
   */
  public getUserHighestRolePosition(userId: string): number {
    return this.getUserRoles(userId).reduce(
      (highest, role) => Math.max(highest, role.position),
      -1
    );
  }

  /**
   * Whether a member holds ADMINISTRATOR (the owner included, since the owner
   * is handed every permission bit). Admin comes from the built-in Admin role,
   * whose position in the drag-and-drop ranking is arbitrary, so it is checked
   * by permission instead of by position.
   */
  public isAdminMember(userId: string): boolean {
    return hasPermission(this.getUserPermissions(userId), Permission.ADMINISTRATOR);
  }

  /**
   * Ranking used inside each member-list group: admins are pinned above
   * everyone else regardless of role ordering (#489), then the highest role
   * position decides, and finally the nickname.
   */
  private compareMembersForDisplay(a: UserSummary, b: UserSummary): number {
    const adminDiff = Number(this.isAdminMember(b.id)) - Number(this.isAdminMember(a.id));
    if (adminDiff !== 0) return adminDiff;
    const diff = this.getUserHighestRolePosition(b.id) - this.getUserHighestRolePosition(a.id);
    if (diff !== 0) return diff;
    return a.nickname.localeCompare(b.nickname);
  }

  /** Members ordered by admin, then role ranking, then alphabetically (#262, #489). */
  public getMembersInDisplayOrder(): UserSummary[] {
    const members = [...(this.serverDetails?.members ?? [])];
    return members.sort((a, b) => this.compareMembersForDisplay(a, b));
  }

  /**
   * Returns all known members (online + offline), sorted with online/voice
   * users first, then offline, each sub-group sorted by admin, then role, then
   * name (#401, #489).
   */
  public getAllMembersInDisplayOrder(): UserSummary[] {
    const all = new Map<string, UserSummary>();

    // Online members first (authoritative state)
    for (const m of (this.serverDetails?.members ?? [])) {
      all.set(m.id, m.invisible ? { ...m, status: 'DISCONNECTED' } : m);
    }
    // Offline members from knownMembers
    for (const [id, m] of this.knownMembers) {
      if (!all.has(id)) {
        all.set(id, { ...m, status: 'DISCONNECTED' as const });
      }
    }

    return Array.from(all.values()).sort((a, b) => {
      const aOnline = a.status !== 'DISCONNECTED' ? 0 : 1;
      const bOnline = b.status !== 'DISCONNECTED' ? 0 : 1;
      if (aOnline !== bOnline) return aOnline - bOnline;
      return this.compareMembersForDisplay(a, b);
    });
  }

  /** Bot user arguments reference persisted human users, not separate bot accounts. */
  public getHumanMembersInDisplayOrder(): UserSummary[] {
    return this.getAllMembersInDisplayOrder().filter((member) => !member.isBot);
  }

  public recalculateMyPermissions(): number {
    if (!this.currentUser) {
      this.myPermissions = 0;
      return this.myPermissions;
    }
    this.myPermissions = this.getUserPermissions(this.currentUser.id);
    if (this.serverDetails) {
      this.serverDetails.myPermissions = this.myPermissions;
    }
    return this.myPermissions;
  }

  public hasPermission(permission: Permission): boolean {
    return hasPermission(this.myPermissions, permission);
  }

  public clear(): void {
    clientLog.info('SERVER_HOST', 'Server store cleared');
    this.serverDetails = null;
    this.currentUser = null;
    this.voiceRestrictions = { serverMuted: false, serverDeafened: false };
    this.activeTextChannelId = null;
    this.roles = [];
    this.userRoles = [];
    this.ownerId = null;
    this.myPermissions = 0;
    this.knownMembers = new Map();
    this.slashCommands = [];
    this.bus.emit('server.voice_restrictions_updated');
    this.bus.emit('server.updated');
  }
}

export function createServerStore(): ServerStore {
  return new ServerStore();
}

let activeServerStore = createServerStore();

export function setActiveServerStore(store: ServerStore): void {
  activeServerStore = store;
}

export function getActiveServerStore(): ServerStore {
  return activeServerStore;
}

export const serverStore = createActiveProxy<ServerStore>(() => activeServerStore);
