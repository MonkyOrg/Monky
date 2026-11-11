export const browserHomePtBR = {
  'browser.homeTitle': 'Seu navegador no Monky',
  'browser.homeHint': 'Digite um endereço na barra acima para começar a navegar.',
  'browser.privacy': 'O host controla este navegador temporário. Todos nesta sala veem os pixels, inclusive o que você digitar ou abrir. Cookies e estado da navegação não são enviados ao bot. Fechar o host encerra a transmissão e apaga os dados.',
};

export const browserHomeEn: Record<keyof typeof browserHomePtBR, string> = {
  'browser.homeTitle': 'Your Monky browser',
  'browser.homeHint': 'Enter an address in the bar above to start browsing.',
  'browser.privacy': 'The host controls this temporary browser. Everyone in this room sees its pixels, including anything you type or open. Cookies and browsing state are not sent to the bot. Closing the host ends the broadcast and erases its data.',
};

export const browserHomeMessages = { 'pt-BR': browserHomePtBR, en: browserHomeEn };
