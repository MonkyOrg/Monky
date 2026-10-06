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
};

inline constexpr const Strings& textFor(Language language) {
  return language == Language::portuguese ? kPortuguese : kEnglish;
}

}  // namespace monky::light::ui
