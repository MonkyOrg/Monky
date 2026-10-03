# Primeiros passos

Este guia leva você do primeiro acesso à sua primeira conversa. Você precisa
do [aplicativo instalado](/download) e do endereço de um servidor — ou pode
criar o seu pelo próprio Monky.

## 1. Crie ou importe sua identidade

Na primeira abertura, escolha **Criar nova identidade**. Se já usa o Monky em
outro computador e quer manter a mesma conta nos servidores, escolha
**Importar identidade existente** e use o backup exportado naquele dispositivo.

<AppScreenshot src="/screenshots/identidade-pt.png" alt="Primeira abertura do Monky, com as opções Criar nova identidade e Importar identidade existente." caption="A identidade substitui um cadastro central. Criar outra identidade não recupera os cargos e vínculos da anterior." />

Na sequência, informe seu **nickname** e, se quiser, escolha um avatar. Esse
perfil é global: ele aparece em todos os servidores conectados e pode ser
alterado depois em **Configurações → Meu Perfil** sem criar uma conta nova.

### Guarde um backup da identidade

Em **Configurações → Meu Perfil**, use a exportação de identidade e escolha
uma senha forte. Guarde o arquivo em local seguro; não compartilhe o arquivo
nem sua senha. O código público de identidade é diferente do backup que
permite usar sua conta em outro dispositivo. Sem o backup, criar outra
identidade não recupera os acessos da anterior.

## 2. Escolha como entrar

Após criar a identidade e o perfil, o Monky abre a **Home**. Ela tem o trilho
de servidores à esquerda, a lista de **Mensagens diretas** e a página
**Amigos** com as abas Disponível, Todos e Pendente. Se nenhum servidor estiver
salvo, o botão **+** no trilho fica destacado.

<AppScreenshot src="/screenshots/inicio-pt.png" alt="Home do Monky com trilho de servidores, mensagens diretas e a página Amigos." caption="Use o botão + no trilho para criar ou entrar em um servidor. A Home continua disponível mesmo sem servidores conectados." />

| Situação | Próximo passo |
| --- | --- |
| Alguém já hospeda para o grupo | [Entrar em um servidor](/entrar-em-um-servidor) |
| Quero hospedar no meu computador | [Criar pelo aplicativo](/criar-seu-servidor) |
| Quero um servidor disponível 24 horas | [Hospedar em uma VPS](/hospedar-em-vps) |

Servidores salvos se conectam em segundo plano por padrão para manter presença
de amigos e mensagens diretas. Desative isso em **Configurações → Meu Perfil →
Conexões** se preferir conectar manualmente. O servidor marcado com
**Entrar ao abrir o Monky** continua abrindo em primeiro plano.

## 3. Converse por texto e voz

Depois de conectar, escolha um **canal de texto** para enviar uma mensagem.
Para uma chamada, clique em um **canal de voz**: conectar ao servidor não liga
o microfone automaticamente.

Os controles inferiores permitem mutar o microfone, ensurdecer e abrir as
configurações. Revise o dispositivo de entrada em **Voz e Vídeo** antes da
primeira chamada. Use fones ao testar o retorno do microfone.

Continue em [Conversas, voz e mídia](/usando-o-app). Para corrigir uma falha de
conexão ou áudio, consulte [Solução de problemas](/solucao-de-problemas).

::: tip Você não precisa instalar um bot para usar o Monky
Bots são opcionais. Para usar um que já existe no seu servidor, siga o
[guia de bots](/bots); para programar um, use a
[documentação do SDK de bots](/bots-desenvolvimento).
:::
