import {
  ADMIN_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  isValidMessageContent,
  isValidNickname,
  Permission,
  LIMITS,
  QUALITY_PRESETS,
  PROTOCOL_VERSION,
  canAccessChannel,
  channelCreateSchema,
  channelUpdateSchema,
  hasPermission,
} from '../src/index.js';
import './botInteractions.test.js';

console.log('=== Início dos Testes Unitários de @monky/shared ===');

// Test Nickname validation
console.assert(isValidNickname('Murilo') === true, 'Murilo deve ser válido');
console.assert(isValidNickname('Joao_123') === true, 'Joao_123 deve ser válido');
console.assert(isValidNickname('A') === false, '1 caractere deve ser inválido');
console.assert(isValidNickname('a'.repeat(33)) === false, '33 caracteres deve ser inválido');
console.assert(isValidNickname('Murilo<script>') === false, 'Caracteres especiais inválidos');
console.log('✔ Validações de Nickname passaram');

// Test Message validation
console.assert(isValidMessageContent('Olá mundo') === true, 'Mensagem normal válida');
console.assert(isValidMessageContent('') === false, 'Mensagem vazia inválida');
console.assert(isValidMessageContent('a'.repeat(2001)) === false, 'Mensagem acima de 2000 chars inválida');
console.assert(isValidMessageContent('a'.repeat(2000)) === true, 'Mensagem de 2000 chars válida');
console.log('✔ Validações de Mensagem passaram');

// Test Quality Presets
console.assert(QUALITY_PRESETS.ECONOMIC.audioBitrateKbps === 24, 'Preset Econômico de áudio');
console.assert(QUALITY_PRESETS.NORMAL.audioBitrateKbps === 32, 'Preset Normal de áudio');
console.assert(QUALITY_PRESETS.HIGH.audioBitrateKbps === 48, 'Preset Alta de áudio');
console.assert(QUALITY_PRESETS.GAMING.name === 'Gaming Mode', 'Preset Gaming Mode');
console.log('✔ Presets de Qualidade verificados');

// Test Protocol Version
console.assert(PROTOCOL_VERSION === 8, 'Versão do protocolo deve ser 8');
console.assert(LIMITS.SFU_DEFAULT_MIN_PORT === 40000, 'Porta mínima padrão SFU');
console.assert(LIMITS.SFU_DEFAULT_MAX_PORT === 49151, 'Porta máxima padrão SFU');
console.assert(
  LIMITS.SFU_DEFAULT_MAX_PORT < LIMITS.TURN_RELAY_MIN_PORT,
  'Range UDP do SFU não pode invadir o range de relay do coturn (#515)'
);
console.log('✔ Versão do protocolo e limites SFU verificados');

console.assert(hasPermission(DEFAULT_PERMISSIONS, Permission.SPEAK) === true, 'Cargo padrão deve poder falar');
console.assert(hasPermission(DEFAULT_PERMISSIONS, Permission.MANAGE_SERVER) === false, 'Cargo padrão não administra servidor');
console.assert(hasPermission(ADMIN_PERMISSIONS, Permission.MOVE_MEMBERS) === true, 'Admin deve ter todas permissões');
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
  canAccessChannel(privateChannel, Permission.MANAGE_CHANNELS, []) === true,
  'Quem gerencia canais acessa mesmo sem o cargo'
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
  canAccessChannel({ isPrivate: true, allowedRoleIds: [] }, Permission.MANAGE_CHANNELS, []) === true,
  'Canal privado sem cargos continua acessível a quem gerencia canais'
);
console.log('✔ Regras de visibilidade de canal privado verificadas (#384)');

// Schemas de canal (#384)
const createDefaults = channelCreateSchema.safeParse({ name: 'geral', type: 'TEXT' });
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

console.log('=== Todos os testes unitários passaram com sucesso! ===');
