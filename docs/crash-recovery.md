# Recuperação de falhas fatais do cliente (#454)

## Comportamento

O Main observa a janela principal. Encerramento anormal do renderer, falha ao
carregar o documento/preload e erros na construção ou inicialização obrigatória
da interface abrem **outra BrowserWindow**, sem recarregar o bundle defeituoso.
Um prazo de 45 segundos sem sinal de interface pronta cobre módulos ausentes,
erros de importação e inicialização travada. O onboarding sinaliza prontidão
antes de esperar a criação/importação de identidade.

A nova janela não acessa identidade, servidores ou os IPCs gerais do app.
Tem `contextIsolation: true`, `nodeIntegration: false`, sessão separada,
conteúdo local com CSP restritiva e preload específico. Os canais ficam no
contrato compartilhado; o Main verifica remetente, frame, argumentos e URL da
janela de recuperação.

O painel segue as cores, espaçamentos e botões do app, com um macaco vetorial
monocromático em vez de emoji. As fontes empacotadas são embutidas na página pelo
Main; se estiverem indisponíveis, a tela usa fontes do sistema e registra o aviso.
O SVG e os estilos não dependem do bundle, dos ícones nem das URLs de assets do
renderer. A barra escura mantém os controles nativos da janela, utilizáveis mesmo
se o preload falhar. O diagnóstico expandido permanece acessível por rolagem em
janelas menores.

- **Reportar bug** abre o mesmo formulário de **Configurações › Sobre e Updates**:
  `https://github.com/MonkyOrg/Monky/discussions/new?category=bug-reports`.
  A URL não contém diagnóstico nem tenta preencher campos por parâmetros:
  esse preenchimento não tem suporte documentado em formulários de Discussions.
- O diagnóstico integral é copiado **somente após ação explícita**, com aviso
  prévio. O usuário deve colar em **Contexto adicional**, campo existente em
  `.github/DISCUSSION_TEMPLATE/bug-reports.yml`. A aplicação não publica uma
  Discussion, não faz upload e não inventa passos de reprodução.
- **Reabrir Monky** chama `app.relaunch()` e encerra pelo fluxo normal do Main.
  Reportar não reinicia nem fecha a tela. Fechar a recuperação encerra o app,
  em vez de esconder uma janela sem interface na bandeja.
- Português e inglês seguem o idioma escolhido. O Main guarda apenas o código
  do idioma em `main-language.json`, dentro do perfil, para quando o renderer
  falha antes de conseguir sincronizar sua preferência.

O diagnóstico contém identificador/horário da ocorrência, versões, sistema,
arquitetura, tempo aberto, motivo/código de saída, tipo de exceção e até quatro
localizações de código do app. Não contém mensagens arbitrárias de exceção,
URLs, caminhos pessoais, identidade, tokens, mensagens de chat nem conteúdo
integral dos logs. A mesma ocorrência é registrada no `ClientLogger` existente,
respeitando a configuração de logging. O diagnóstico não é um dump de memória.

## Limites

Rejeições comuns de Promises e falhas recuperáveis de rede/mídia **não** ativam
essa tela. Ela é uma contenção de falhas fatais, não corrige suas causas.

Se a própria janela de recuperação morrer, falhar ao carregar ou não confirmar
seu preload em dez segundos, o Main oferece um diálogo nativo. Há no máximo uma
tentativa de janela de recuperação por processo; nenhuma recarga ou reinício
automático.

Um abort nativo, encerramento do **Main**, falta de memória que mate o processo
inteiro ou indisponibilidade do sistema operacional **não podem mostrar UI no
processo terminado**. Nesses casos é necessário abrir o aplicativo novamente.
Não foi adicionado um supervisor externo, nem um handler global que engula
`uncaughtException` e tente continuar executando um Main possivelmente corrompido.
A captura de bootstrap do Main começa após seus módulos terem sido carregados.

## Regressão local

Na raiz do checkout, com as dependências já disponíveis:

```powershell
npm run test:crashes --workspace=apps/client
```

O smoke transpila somente os módulos necessários para um diretório descartável
dentro de `apps\client`, sem sobrescrever `dist`/`dist-electron`. Usa seu próprio
`userData`, `sessionData`, `MONKY_HOME` e lock de instância. Encerra apenas os
processos que iniciou e remove seus artefatos. Não fecha a versão instalada,
não abre um navegador real e não altera a área de transferência do usuário.

O smoke encerra renderers de verdade, exercita falhas síncronas/assíncronas de
bootstrap, os botões da página, o fallback nativo e um `app.relaunch()` real,
confirmando novo PID e o mesmo perfil isolado. O formulário é verificado pelo
destino exato e pelo diagnóstico copiado. Colar o diagnóstico e revisar o
formulário depois do login no GitHub exige QA manual autenticado.
Nenhum relatório é publicado pelo teste.
