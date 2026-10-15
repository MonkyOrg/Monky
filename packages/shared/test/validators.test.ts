import assert from 'node:assert/strict';
import {
  ADMIN_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  authConnectSchema,
  getNicknameIssue,
  isValidMessageContent,
  isValidNickname,
  nicknameSchema,
  normalizeNickname,
  type NicknameIssue,
  Permission,
  LIMITS,
  QUALITY_PRESETS,
  isMotionQualityPreset,
  restoreQualityPreset,
  type QualityPresetType,
  PROTOCOL_VERSION,
  canAccessChannel,
  channelCreateSchema,
  channelPermissionOverwritesSchema,
  channelUpdateSchema,
  hasPermission,
  adminVoiceRestrictionsGetSchema,
  adminMuteUserSchema,
  adminDeafenUserSchema,
  voiceRestrictionsUpdatedSchema,
  dmRelaySendSchema,
  ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX,
  userActivitySchema,
  userUpdateActivitySchema,
  voiceAfkSchema,
  AFK_TIMEOUT_OPTIONS_SECONDS,
  isAfkTimeoutSeconds,
} from '../src/index.js';
import './botInteractions.test.js';
import './botSettings.test.js';
import './reactions.test.js';
import './screenSubscriptions.test.js';
import './nativeAudioIpc.test.js';

console.log('=== Início dos Testes Unitários de @monky/shared ===');

// Test Nickname validation
assert.equal(isValidNickname('Murilo'), true, 'Murilo deve ser válido');
assert.equal(isValidNickname('Joao_123'), true, 'Joao_123 deve ser válido');
assert.equal(isValidNickname('A'), false, '1 caractere deve ser inválido');
assert.equal(isValidNickname('a'.repeat(33)), false, '33 caracteres deve ser inválido');
assert.equal(isValidNickname('Murilo<script>'), false, 'Caracteres especiais inválidos');

// Qualquer idioma, acento e emoji, inclusive sequências com joiner, bandeiras e teclas (#567).
for (const accepted of [
  'João', 'José da Silva', "D'Ávila", 'Ângela 🐒', 'Ольга', '李雷', 'हिंदी', '한국어 이름', 'محمد', 'שלום',
  '👨‍👩‍👧', '👩🏽‍💻 Ana', '🏳️‍🌈', '🏳️‍⚧️', '❤️‍🔥', '❤️', '☺️', '🇧🇷 Brasil', '1️⃣ Um', '™ Ana ★',
]) {
  assert.equal(getNicknameIssue(accepted), null, `${accepted} deve ser aceito`);
}
// Invisíveis e de controle deixariam um nome em branco ou dois nomes diferentes idênticos na tela.
const refusedNicknames: Array<[string, NicknameIssue]> = [
  ['Ad\u200Bmin', 'invalid_characters'],
  ['Ad\u200Dmin', 'invalid_characters'],
  ['Ad\u200Cmin', 'invalid_characters'],
  ['Ad\u034Fmin', 'invalid_characters'],
  ['Ad\uFE0Fmin', 'invalid_characters'],
  ['Ana\u200E', 'invalid_characters'],
  ['\u202Enimda', 'invalid_characters'],
  ['Ana\u2066Bia', 'invalid_characters'],
  ['Ana\u00ADBia', 'invalid_characters'],
  ['\u3164\u3164', 'invalid_characters'],
  ['\u2800\u2800', 'invalid_characters'],
  ['Ana\u0000', 'invalid_characters'],
  ['Ana\tBia', 'invalid_characters'],
  ['Ana\u2028Bia', 'invalid_characters'],
  ['Ana\uD800', 'invalid_characters'],
  ['Ana\uE000', 'invalid_characters'],
  ['Ana > Bia', 'invalid_characters'],
  ['🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 'invalid_characters'],
  ['  a  ', 'too_short'],
  ['a'.repeat(33), 'too_long'],
];
for (const [refused, issue] of refusedNicknames) {
  assert.equal(getNicknameIssue(refused), issue, `${JSON.stringify(refused)} deve ser recusado por ${issue}`);
}
const decomposed = 'Joa\u0303o';
assert.equal(normalizeNickname(`  ${decomposed} `), 'João', 'apelido é guardado sem espaços nas pontas e em NFC');
assert.equal(nicknameSchema.parse(decomposed), nicknameSchema.parse('João'), 'NFD e NFC são o mesmo nome');
assert.equal(authConnectSchema.shape.nickname.parse(' Ângela 🐒 '), 'Ângela 🐒');
const invisible = nicknameSchema.safeParse('Ad\u200Bmin');
assert.equal(invisible.success, false);
assert.notEqual(invisible.error?.errors[0]?.message, 'Nickname contém caracteres inválidos',
  'a recusa nova não pode ser confundida com a de servidores antigos, que não aceitavam acentos');
console.log('✔ Validações de Nickname passaram');

// Test Message validation
console.assert(isValidMessageContent('Olá mundo') === true, 'Mensagem normal válida');
console.assert(isValidMessageContent('') === false, 'Mensagem vazia inválida');
assert.equal(isValidMessageContent('a'.repeat(16001)), false);
assert.equal(isValidMessageContent('a'.repeat(16000)), true);
console.log('✔ Validações de Mensagem passaram');

// Test Quality Presets
console.assert(QUALITY_PRESETS.ECONOMIC.audioBitrateKbps === 24, 'Preset Leve de áudio');
console.assert(QUALITY_PRESETS.NORMAL.audioBitrateKbps === 32, 'Preset Padrão de áudio');
console.assert(QUALITY_PRESETS.HIGH.audioBitrateKbps === 48, 'Preset Nítido de áudio');
assert.deepEqual(Object.values(QUALITY_PRESETS).map(profile => profile.name),
  ['Leve', 'Padrão', 'Nítido', 'Fluido', 'Ultra', 'Cinema', 'Extremo']);
const presetLadder = Object.values(QUALITY_PRESETS);
for (const [index, profile] of presetLadder.entries()) {
  assert.ok(profile.screenFps >= 30 && profile.cameraFps >= 30, `${profile.name} não fica abaixo de 30 FPS`);
  const previous = presetLadder[index - 1];
  if (!previous) continue;
  for (const key of ['audioBitrateKbps', 'cameraBitrateKbps', 'screenBitrateKbps', 'screenFps'] as const)
    assert.ok(profile[key] >= previous[key], `${profile.name} não reduz ${key} em relação a ${previous.name}`);
  assert.ok(profile.screenWidth * profile.screenHeight * profile.screenFps
    > previous.screenWidth * previous.screenHeight * previous.screenFps, `${profile.name} sobe a tela`);
}
assert.deepEqual([QUALITY_PRESETS.UHD120.screenWidth, QUALITY_PRESETS.UHD120.screenHeight, QUALITY_PRESETS.UHD120.screenFps],
  [3840, 2160, 120]);
assert.equal(restoreQualityPreset('ULTRA'), 'GAMING', 'O antigo ULTRA era o degrau 1080p60, hoje Fluido');
assert.equal(restoreQualityPreset('UHD120'), 'UHD120');
assert.equal(restoreQualityPreset('CUSTOM'), 'CUSTOM');
for (const invalid of [undefined, null, 'toString', 'unknown', 3]) assert.equal(restoreQualityPreset(invalid), 'NORMAL');
const steady: QualityPresetType[] = ['ECONOMIC', 'NORMAL', 'HIGH', 'CUSTOM'];
const motion: QualityPresetType[] = ['GAMING', 'QHD', 'UHD', 'UHD120'];
assert.deepEqual(steady.filter(isMotionQualityPreset), []);
assert.deepEqual(motion.filter(isMotionQualityPreset), motion);
console.log('✔ Presets de Qualidade verificados');

// Test Protocol Version
assert.equal(PROTOCOL_VERSION, 39);
console.assert(LIMITS.SFU_DEFAULT_MIN_PORT === 40000, 'Porta mínima padrão SFU');
console.assert(LIMITS.SFU_DEFAULT_MAX_PORT === 49151, 'Porta máxima padrão SFU');
console.assert(
  LIMITS.SFU_DEFAULT_MAX_PORT < LIMITS.TURN_RELAY_MIN_PORT,
  'Range UDP do SFU não pode invadir o range de relay do coturn (#515)'
);
console.log('✔ Versão do protocolo e limites SFU verificados');

assert.deepEqual(adminMuteUserSchema.parse({ targetUserId: 'member', muted: true }), { targetUserId: 'member', muted: true });
assert.deepEqual(adminDeafenUserSchema.parse({ targetUserId: 'member', deafened: false }), { targetUserId: 'member', deafened: false });
assert.equal(adminMuteUserSchema.safeParse({ targetSessionId: 'device', muted: true }).success, false);
assert.equal(adminMuteUserSchema.safeParse({ targetUserId: 'member', muted: 'false' }).success, false);
assert.equal(adminDeafenUserSchema.safeParse({ targetUserId: 'member', deafened: 0 }).success, false);
for (const targetUserId of [undefined, null, {}, '', 'x'.repeat(129)]) {
  assert.equal(adminVoiceRestrictionsGetSchema.safeParse({ targetUserId }).success, false);
}
assert.equal(voiceRestrictionsUpdatedSchema.safeParse({ userId: 'member', serverMuted: true, serverDeafened: false }).success, true);
assert.equal(voiceRestrictionsUpdatedSchema.safeParse({ userId: 'member', serverMuted: true }).success, false);

const dmKey = `${ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX}${'ab'.repeat(32)}`;
const dmRelay = dmRelaySendSchema.parse({
  relayId: 'relay-1',
  items: [{ to: dmKey.toUpperCase(), kind: 'friend', data: 'opaque' }],
});
assert.equal(dmRelay.items[0].to, dmKey);
assert.equal(dmRelaySendSchema.safeParse({ relayId: 'relay-1', items: [] }).success, false);
assert.equal(dmRelaySendSchema.safeParse({ relayId: 'relay-1', items: Array.from({ length: LIMITS.DM_RELAY_MAX_ITEMS + 1 }, () => ({ to: dmKey, kind: 'signal', data: '' })) }).success, false);
assert.equal(dmRelaySendSchema.safeParse({ relayId: 'relay-1', items: [{ to: 'ab'.repeat(32), kind: 'signal', data: '' }] }).success, false);
assert.equal(dmRelaySendSchema.safeParse({ relayId: 'relay-1', items: [{ to: dmKey, kind: 'envelope', data: 'x'.repeat(LIMITS.DM_RELAY_DATA_MAX_LENGTH + 1) }] }).success, false);
assert.equal(dmRelaySendSchema.safeParse({ relayId: 'relay-1', items: [{ to: dmKey, kind: 'file', data: 'x'.repeat(LIMITS.DM_RELAY_FILE_DATA_MAX_LENGTH) }] }).success, true);
assert.equal(dmRelaySendSchema.safeParse({ relayId: 'relay-1', items: Array.from({ length: 50 }, () => ({ to: dmKey, kind: 'file', data: 'x'.repeat(132_000) })) }).success, false);
assert.equal(voiceRestrictionsUpdatedSchema.safeParse({
  userId: 'member', serverMuted: true, serverDeafened: false, permissionMuted: true,
}).success, true);

console.assert(hasPermission(DEFAULT_PERMISSIONS, Permission.SPEAK) === true, 'Cargo padrão deve poder falar');
console.assert(hasPermission(DEFAULT_PERMISSIONS, Permission.MANAGE_SERVER) === false, 'Cargo padrão não administra servidor');
console.assert(hasPermission(ADMIN_PERMISSIONS, Permission.MOVE_MEMBERS) === true, 'Admin deve ter todas permissões');
assert.equal(channelPermissionOverwritesSchema.safeParse([{ roleId: null, allow: Permission.MANAGE_CHANNELS, deny: 0 }]).success, false);
assert.equal(channelPermissionOverwritesSchema.safeParse([{ roleId: null, allow: 0, deny: Permission.MOVE_MEMBERS }]).success, false);
console.log('✔ Permissões verificadas');

// Visibilidade de canais privados (#384)
const publicChannel = { isPrivate: false, allowedRoleIds: [] };
const privateChannel = { isPrivate: true, allowedRoleIds: ['role-a'] };

console.assert(
  canAccessChannel(publicChannel, DEFAULT_PERMISSIONS, []) === true,
  'Canal público é visível para qualquer membro'
);
console.assert(
  canAccessChannel(privateChannel, DEFAULT_PERMISSIONS, []) === false,
  'Canal privado é invisível para quem não tem o cargo'
);
console.assert(
  canAccessChannel(privateChannel, DEFAULT_PERMISSIONS, ['role-a']) === true,
  'Canal privado é visível para quem tem o cargo permitido'
);
console.assert(
  canAccessChannel(privateChannel, DEFAULT_PERMISSIONS, ['role-b']) === false,
  'Ter outro cargo não dá acesso ao canal privado'
);
console.assert(
  canAccessChannel(privateChannel, Permission.MANAGE_CHANNELS, []) === false,
  'Gerenciar canais não ignora a visibilidade do canal'
);
console.assert(
  canAccessChannel(privateChannel, ADMIN_PERMISSIONS, []) === true,
  'Administrador acessa qualquer canal'
);
console.assert(
  canAccessChannel({ isPrivate: true, allowedRoleIds: [] }, DEFAULT_PERMISSIONS, ['role-a']) === false,
  'Canal privado sem cargos fica restrito a quem gerencia canais'
);
console.assert(
  canAccessChannel({ isPrivate: true, allowedRoleIds: [] }, Permission.MANAGE_CHANNELS, []) === false,
  'Canal privado sem cargos continua fechado sem VIEW_CHANNEL local'
);
console.log('✔ Regras de visibilidade de canal privado verificadas (#384)');

// Schemas de canal (#384)
const createDefaults = channelCreateSchema.safeParse({ name: 'geral', type: 'TEXT' });
console.assert(hasPermission(DEFAULT_PERMISSIONS, Permission.USE_BOT_COMMANDS), 'Novos membros podem usar comandos de bots por padrão');
console.assert(!hasPermission(DEFAULT_PERMISSIONS, Permission.MANAGE_BOTS), 'Novos membros não gerenciam bots por padrão');
console.assert(createDefaults.success && createDefaults.data.botCommandsEnabled === true, 'Novos canais permitem bots por padrão');
console.assert(channelCreateSchema.parse({ name: 'sem-bots', type: 'TEXT', botCommandsEnabled: false }).botCommandsEnabled === false, 'Criação preserva bloqueio explícito de bots');
console.assert(channelUpdateSchema.parse({ channelId: 'c1' }).botCommandsEnabled === undefined, 'Edição parcial não redefine configuração de bots');
console.assert(channelUpdateSchema.parse({ channelId: 'c1', botCommandsEnabled: false }).botCommandsEnabled === false, 'Edição permite bloquear bots');
console.assert(!channelUpdateSchema.safeParse({ channelId: 'c1', botCommandsEnabled: 'false' }).success, 'Configuração de bots exige booleano');
console.assert(createDefaults.success === true, 'Criação sem campos de privacidade deve ser válida');
console.assert(
  createDefaults.success && createDefaults.data.isPrivate === false,
  'Canal criado sem isPrivate nasce público'
);
console.assert(
  createDefaults.success && Array.isArray(createDefaults.data.allowedRoleIds) && createDefaults.data.allowedRoleIds.length === 0,
  'Canal criado sem cargos nasce com lista vazia'
);

const createDuplicated = channelCreateSchema.safeParse({
  name: 'privado',
  type: 'VOICE',
  isPrivate: true,
  allowedRoleIds: ['role-a', 'role-a', 'role-b'],
});
console.assert(
  createDuplicated.success && createDuplicated.data.allowedRoleIds.length === 2,
  'Cargos repetidos são deduplicados na criação'
);

console.assert(
  channelUpdateSchema.safeParse({ channelId: 'c1' }).success === true,
  'Edição só com channelId é válida (nada muda)'
);
console.assert(
  channelUpdateSchema.safeParse({ channelId: 'c1', isPrivate: true }).success === true,
  'Edição pode alternar privacidade sem reenviar o nome'
);
console.assert(
  channelUpdateSchema.safeParse({ name: 'sem-id' }).success === false,
  'Edição sem channelId deve ser rejeitada'
);
console.assert(
  channelUpdateSchema.safeParse({ channelId: 'c1', name: 'a' }).success === false,
  'Nome curto demais deve ser rejeitado na edição'
);
console.log('✔ Schemas de criação e edição de canal verificados (#384)');

// Limite de pessoas do canal de voz: 0 é "sem limite", que é o padrão de todo canal.
assert.equal(channelCreateSchema.parse({ name: 'sala', type: 'VOICE' }).maxParticipants, LIMITS.VOICE_USER_LIMIT_NONE);
assert.equal(channelUpdateSchema.parse({ channelId: 'c1' }).maxParticipants, undefined, 'Edição parcial não mexe no limite');
for (const limit of [0, 1, LIMITS.VOICE_USER_LIMIT_MAX]) {
  assert.equal(channelUpdateSchema.safeParse({ channelId: 'c1', maxParticipants: limit }).success, true, `limite ${limit}`);
}
for (const limit of [-1, 1.5, LIMITS.VOICE_USER_LIMIT_MAX + 1, '6']) {
  assert.equal(channelUpdateSchema.safeParse({ channelId: 'c1', maxParticipants: limit }).success, false, `limite ${limit}`);
}
assert.equal(voiceAfkSchema.safeParse({ channelId: 'c1' }).success, true);
assert.equal(voiceAfkSchema.safeParse({ channelId: '' }).success, false);
assert.equal(voiceAfkSchema.safeParse({ channelId: 'c1', target: 'c2' }).success, false, 'o pedido de AFK só nomeia a sala atual');
assert.deepEqual(AFK_TIMEOUT_OPTIONS_SECONDS.filter(isAfkTimeoutSeconds), [...AFK_TIMEOUT_OPTIONS_SECONDS]);
assert.equal(isAfkTimeoutSeconds(LIMITS.AFK_TIMEOUT_DEFAULT_SECONDS), true, 'o padrão é uma das opções oferecidas');
for (const value of [0, 120, '900', null]) assert.equal(isAfkTimeoutSeconds(value), false, `inatividade ${String(value)}`);
console.log('✔ Limite de pessoas e canal AFK verificados');

// Presença de jogo e convites de partida (#675)
console.assert(
  userActivitySchema.safeParse({
    source: 'steam', appId: 548430, name: 'Deep Rock Galactic', startedAt: 1_700_000_000_000,
  }).success === true,
  'Atividade da Steam com appid, nome e início é válida'
);
console.assert(
  userActivitySchema.safeParse({ source: 'steam', appId: 548430, name: 'Deep Rock Galactic' }).success === false,
  'Sem o início não há contador: o campo é obrigatório'
);
console.assert(
  userActivitySchema.safeParse({
    source: 'steam', appId: 1, name: 'x', startedAt: -1,
  }).success === false,
  'Início negativo é rejeitado'
);
console.assert(
  userActivitySchema.safeParse({
    source: 'steam', appId: 1, name: 'x', startedAt: 1, iconBase64: '/9j/4AAQSkZJRg==',
  }).success === true,
  'Base64 de JPEG é aceito como ícone'
);
console.assert(
  userActivitySchema.safeParse({
    source: 'steam', appId: 1, name: 'x', startedAt: 1, iconBase64: 'iVBORw0KGgo=',
  }).success === false,
  'Só JPEG: o prefixo /9j/ é o que autoriza virar data URI'
);
console.assert(
  userActivitySchema.safeParse({
    source: 'steam', appId: 1, name: 'x', startedAt: 1,
    iconBase64: `/9j/${'A'.repeat(LIMITS.MAX_ACTIVITY_ICON_LENGTH)}`,
  }).success === false,
  'O ícone tem teto: o campo não é um canal para dados em massa'
);
console.assert(
  userUpdateActivitySchema.safeParse({ activity: null }).success === true,
  'Limpar a atividade é tão válido quanto publicá-la — é o que o toggle desligado envia'
);
console.assert(
  userActivitySchema.safeParse({ source: 'epic', appId: 1, name: 'x' }).success === false,
  'Só a Steam é aceita como fonte hoje'
);
console.assert(
  userActivitySchema.safeParse({ source: 'steam', appId: 0, name: 'x' }).success === false,
  'AppId precisa ser positivo'
);
console.assert(
  userActivitySchema.safeParse({
    source: 'steam', appId: 1, name: 'x', executablePath: 'C:/jogo.exe',
  }).success === false,
  'Campos extras são rejeitados: caminho de executável nunca deve trafegar'
);

console.log('✔ Schemas de presença de jogo verificados (#675)');

console.log('=== Todos os testes unitários passaram com sucesso! ===');
