#pragma once

namespace monky::light::ui {

// The Light has no settings panel yet, so the interface follows the operating
// system language. Choosing a language inside the application belongs to the
// settings panel, which is not part of this milestone.
enum class Language { english, portuguese };

// Every visible string of the interface. Kept in one place so a future settings
// panel can switch languages without hunting for literals in platform code.
struct Strings {
  const char* application;
  const char* connecting;
  const char* authenticating;
  const char* connected;
  const char* reconnecting;
  const char* disconnected;
  const char* joining;
  const char* inCall;
  const char* channels;
  const char* noChannels;
  const char* leaveChannel;
  const char* muteMicrophone;
  const char* deafen;
  const char* byServer;
  const char* noPermissionToSpeak;
  const char* audioDevices;
  const char* input;
  const char* output;
  const char* systemDefault;
  const char* usingDefault;
  const char* reconnectNow;
  const char* quit;
  const char* microphonePending;
  const char* microphoneRefused;
  const char* participant;
  const char* participants;
  const char* kicked;
  // The sign-in was refused because the server's identity key does not match (server-key-auth, #821).
  const char* serverKeyChanged;
  const char* serverKeyMissing;
  const char* serverKeyOfOtherServer;
  const char* serverKeyInvalid;
  const char* pushToTalk;
  const char* key;
  const char* noPushToTalkKey;
  const char* keyUnavailable;
  const char* inThisCall;
  const char* you;
  const char* speaking;
  const char* volume;
  // macOS only lets a trusted application see keys pressed in other applications.
  const char* accessibilityRequired;
  const char* switchServer;
  const char* connectTitle;
  const char* connectPrompt;
  const char* serverField;
  const char* nicknameField;
  const char* passwordField;
  const char* connect;
  const char* cancel;
  const char* missingServer;
  const char* invalidServer;
  const char* missingNickname;
  const char* nicknameTooLong;
  const char* wrongPassword;
  const char* nicknameTaken;
  const char* nicknameRefused;
  const char* profileUnavailable;
};

inline constexpr Strings kEnglish{
    "Monky Light",
    "Connecting…",
    "Authenticating…",
    "Connected",
    "Reconnecting…",
    "Disconnected",
    "Joining the channel…",
    "In a call",
    "Voice channels",
    "No voice channels",
    "Leave the channel",
    "Mute the microphone",
    "Deafen",
    "by the server",
    "no permission to speak",
    "Audio devices",
    "Input",
    "Output",
    "System default",
    "unavailable, using the default",
    "Reconnect now",
    "Quit Monky Light",
    "Waiting for microphone permission…",
    "Microphone access was refused",
    "participant",
    "participants",
    "Removed from the channel",
    "This server's identity key changed since you last joined. Monky Light did not join, so your sign-in is not handed to another server. If the owner changed it, start Monky Light with a new invitation link from them.",
    "This server presented an identity key before and now presented none. Monky Light did not join, so your sign-in is not handed to another server.",
    "This server presented the identity key of another server of this profile. Monky Light did not join, because a server may be relaying that one's sign-in.",
    "The server did not prove it holds the identity key it presented. Monky Light did not join.",
    "Push-to-talk",
    "key",
    "no key: start with --ptt-key",
    "not on this system",
    "In the call",
    "you",
    "speaking",
    "Volume",
    "Push-to-talk cannot see the key yet. Allow Monky Light in System Settings › Privacy & Security › Accessibility.",
    "Change server…",
    "Connect to a server",
    "Paste the invitation link someone sent you, or the server address.",
    "Invitation link or server address",
    "Nickname",
    "Password (only if the server asks)",
    "Connect",
    "Cancel",
    "Paste an invitation link or a server address.",
    "This is not an invitation link nor a ws:// or wss:// address.",
    "Choose a nickname.",
    "The nickname can have at most 32 characters.",
    "The server refused the password. Type the password of this server.",
    "Someone on this server already uses this nickname. Choose another one.",
    "The server did not accept this nickname. Choose another one.",
    "Monky Light could not open its profile. It may already be running: look for its icon near the clock.",
};

inline constexpr Strings kPortuguese{
    "Monky Light",
    "Conectando…",
    "Autenticando…",
    "Conectado",
    "Reconectando…",
    "Desconectado",
    "Entrando no canal…",
    "Em chamada",
    "Canais de voz",
    "Nenhum canal de voz",
    "Sair do canal",
    "Microfone mudo",
    "Silenciar tudo",
    "pelo servidor",
    "sem permissão para falar",
    "Dispositivos de áudio",
    "Entrada",
    "Saída",
    "Padrão do sistema",
    "indisponível, usando o padrão",
    "Reconectar agora",
    "Sair do Monky Light",
    "Aguardando permissão do microfone…",
    "Acesso ao microfone recusado",
    "participante",
    "participantes",
    "Removido do canal",
    "A chave de identidade deste servidor mudou desde a última vez que você entrou. O Monky Light não entrou para não entregar o seu login a outro servidor. Se o dono a trocou, abra o Monky Light com um link de convite novo dele.",
    "Este servidor já apresentou uma chave de identidade e agora não apresentou nenhuma. O Monky Light não entrou para não entregar o seu login a outro servidor.",
    "Este servidor apresentou a chave de identidade de outro servidor deste perfil. O Monky Light não entrou, porque um servidor pode estar repassando o login daquele.",
    "O servidor não provou ter a chave de identidade que apresentou. O Monky Light não entrou.",
    "Apertar para falar",
    "tecla",
    "sem tecla: abra com --ptt-key",
    "não existe neste sistema",
    "Na chamada",
    "você",
    "falando",
    "Volume",
    "O apertar para falar ainda não vê a tecla. Permita o Monky Light em Ajustes do Sistema › Privacidade e Segurança › Acessibilidade.",
    "Trocar de servidor…",
    "Conectar a um servidor",
    "Cole o link de convite que te mandaram, ou o endereço do servidor.",
    "Link de convite ou endereço do servidor",
    "Apelido",
    "Senha (só se o servidor pedir)",
    "Conectar",
    "Cancelar",
    "Cole um link de convite ou o endereço de um servidor.",
    "Isto não é um link de convite nem um endereço ws:// ou wss://.",
    "Escolha um apelido.",
    "O apelido pode ter no máximo 32 caracteres.",
    "O servidor recusou a senha. Digite a senha deste servidor.",
    "Alguém neste servidor já usa este apelido. Escolha outro.",
    "O servidor não aceitou este apelido. Escolha outro.",
    "O Monky Light não conseguiu abrir o perfil. Ele talvez já esteja aberto: procure o ícone perto do relógio.",
};

inline constexpr const Strings& textFor(Language language) {
  return language == Language::portuguese ? kPortuguese : kEnglish;
}

}  // namespace monky::light::ui
