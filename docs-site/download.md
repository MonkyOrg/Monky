---
title: Download
---

# Download

Os botões abaixo apontam direto para os arquivos da última release — não é preciso procurar nada no GitHub.

<DownloadPanel lang="pt" />

## Qual arquivo escolher

| Sistema | Arquivo | Observação |
|---|---|---|
| Windows 10/11 (x64) | `Monky-<versão>-win-x64-setup.exe` | Instalador — permite escolher a pasta |
| Windows 10/11 (x64) | `Monky-<versão>-win-x64-portable.exe` | Não instala nada, é só executar |
| macOS (Intel / Apple Silicon) | `Monky-<versão>-mac-<arch>.dmg` | Escolha `x64` (Intel) ou `arm64` (M1/M2/M3+) |

## Depois de baixar

Windows e macOS podem exibir um aviso porque o aplicativo ainda não tem
assinatura de distribuição reconhecida por esses sistemas. Um aviso não
prova, por si só, nem corrupção nem segurança.

Antes de autorizar a execução, confirme a origem oficial e
[verifique a release](/verificar-releases). Com o arquivo conferido:

- **Windows**: quando o SmartScreen oferecer a opção, use _Mais informações › Executar assim mesmo_.
- **macOS**: tente abrir pelo menu de contexto do aplicativo e consulte **Privacidade e Segurança** nos Ajustes do Sistema. As opções variam com a versão do macOS.

### macOS: "O aplicativo está danificado e não pode ser aberto"

Essa mensagem pode decorrer da quarentena do Gatekeeper e da ausência de
notarização. Não descarte um download incompleto ou alterado: confira o
checksum do `.dmg` original antes de mudar proteções do sistema.

Depois de conferir a origem, mover o **Monky.app** para *Aplicativos* e
decidir autorizar essa cópia, remova apenas a quarentena desse aplicativo:

```bash
xattr -dr com.apple.quarantine /Applications/Monky.app
```

Tente abrir novamente. Se continuar bloqueado, preserve a mensagem de erro
e confira a compatibilidade do sistema. Não desative o Gatekeeper globalmente
nem remova proteções de outras pastas para tentar resolver.

## Atualizações

O app avisa quando sai uma versão nova. Você também pode conferir em
**Configurações › Sobre e Updates › Verificar atualizações**.

No Windows a atualização é aplicada sozinha: o Monky baixa, instala e reabre.

No macOS o sistema não permite substituir um aplicativo que está em uso, então o Monky baixa o `.dmg`, abre a janela de instalação e **se fecha sozinho** logo em seguida. Arraste o Monky para a pasta *Aplicativos*, confirme a substituição e abra o app de novo.

Para conferir se o arquivo baixado é mesmo o que publicamos, veja [Verificar Releases](/verificar-releases) — toda release traz checksums SHA-256 e assinatura Cosign.

## Sobre o canal beta

As betas saem antes da versão estável e servem para testar o que está por vir. Elas passam pelo mesmo processo de build e assinatura, mas podem conter problemas que ainda não apareceram. Se você só quer usar o Monky, fique na estável.

Dá para receber betas pelo próprio app, sem baixar nada à mão, em
**Configurações › Sobre e Updates**.

## Sobre o CLI

O CLI serve para hospedar um servidor sem interface gráfica, como em uma VPS. A referência completa dos comandos está em [Monky CLI](/cli), e o guia de hospedagem em [Hospedar em VPS](/hospedar-em-vps).
