/**
 * Demo content of the documentation screenshots, one set per app language.
 * People, server and conversations are fictional; nothing here is real data.
 */
export const content = {
  'pt-BR': {
    server: 'Estação Monky',
    text: 'geral',
    planning: 'planejamento',
    announcements: 'avisos',
    voice: 'Sala de conversa',
    gaming: 'Jogatina',
    textCategory: 'Conversas',
    voiceCategory: 'Salas de voz',
    role: 'Facilitadores',
    messages: [
      ['Rafa', 'Bem-vindos à **Estação Monky**! Nosso espaço para conversar e criar juntos.'],
      ['Nina', 'Separei algumas ideias para o fim de semana. Vamos escolher uma atividade?'],
      ['Rafa', 'A sala de voz está pronta. Entrem quando quiserem — o chat continua disponível também.'],
      ['Nina', 'Deixei o encontro de sábado na agenda de eventos. Quem puder, marca interesse 🙌'],
    ],
    reactions: ['🎉', '👍'],
    planningMessage: 'Vamos usar a enquete para escolher a próxima atividade. Dá para ver os comandos do bot digitando / neste canal.',
    event: {
      title: 'Noite de jogos',
      description: 'Uma rodada de jogos cooperativos na sala de voz. Traga sugestões!',
    },
    secondEvent: {
      title: 'Oficina de bots',
      description: 'Vamos criar um comando juntos com o SDK de bots, do zero ao /ping.',
    },
    poll: {
      question: 'Qual atividade fazemos no sábado?',
      options: ['Noite de jogos', 'Sessão de música', 'Maratona de filmes'],
    },
    form: {
      title: 'Inscrição para a oficina',
      description: 'Conte o que você quer aprender. Leva menos de um minuto.',
      fields: {
        name: 'Como podemos te chamar?',
        level: 'Experiência com programação',
        levels: ['Nenhuma', 'Um pouco', 'Bastante'],
        topics: 'O que você quer ver?',
        topicList: ['Comandos', 'Formulários', 'Miniapps'],
        notes: 'Algo mais?',
      },
      submit: 'Enviar inscrição',
    },
  },
  en: {
    server: 'Monky Station',
    text: 'general',
    planning: 'planning',
    announcements: 'announcements',
    voice: 'Hangout',
    gaming: 'Game night',
    textCategory: 'Chat',
    voiceCategory: 'Voice rooms',
    role: 'Facilitators',
    messages: [
      ['Rafa', 'Welcome to **Monky Station**! Our place to talk and build things together.'],
      ['Nina', 'I gathered a few ideas for the weekend. Shall we pick an activity?'],
      ['Rafa', 'The voice room is ready. Join whenever you like — the chat is still here too.'],
      ['Nina', 'Saturday\'s meetup is on the events calendar. Mark yourself as interested 🙌'],
    ],
    reactions: ['🎉', '👍'],
    planningMessage: 'Let\'s use the poll to choose our next activity. Type / in this channel to see the bot commands.',
    event: {
      title: 'Game night',
      description: 'A round of co-op games in the voice room. Bring suggestions!',
    },
    secondEvent: {
      title: 'Bot workshop',
      description: 'We will build a command together with the bot SDK, from scratch to /ping.',
    },
    poll: {
      question: 'What should we do on Saturday?',
      options: ['Game night', 'Music session', 'Movie marathon'],
    },
    form: {
      title: 'Workshop sign-up',
      description: 'Tell us what you want to learn. It takes less than a minute.',
      fields: {
        name: 'What should we call you?',
        level: 'Programming experience',
        levels: ['None', 'Some', 'A lot'],
        topics: 'What do you want to see?',
        topicList: ['Commands', 'Forms', 'Miniapps'],
        notes: 'Anything else?',
      },
      submit: 'Send sign-up',
    },
  },
};
