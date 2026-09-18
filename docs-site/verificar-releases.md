# Verificar Releases

O pipeline oficial publica uma lista de hashes SHA-256 assinada com
[Sigstore Cosign](https://docs.sigstore.dev/) (keyless, via OIDC do GitHub
Actions). São duas verificações diferentes: a **assinatura** identifica quem
publicou a lista; o **hash** confere o arquivo que você baixou.

## 1. Baixe os arquivos da mesma release

Na [página oficial de releases](https://github.com/MonkyOrg/Monky/releases),
baixe o instalador, portable ou pacote desejado e estes três arquivos:

- `checksums-sha256.txt`
- `checksums-sha256.txt.sig`
- `checksums-sha256.txt.crt`

Mantenha-os na mesma pasta. Não misture arquivos de releases diferentes,
mesmo que ambos tenham nomes parecidos.

## 2. Confira a assinatura da lista

[Instale o Cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
e abra o terminal nessa pasta. O comando abaixo funciona em PowerShell,
Bash e Zsh:

```text
cosign verify-blob --signature checksums-sha256.txt.sig --certificate checksums-sha256.txt.crt --certificate-identity "https://github.com/MonkyOrg/Monky/.github/workflows/release.yml@refs/heads/main" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" checksums-sha256.txt
```

Continue somente se o processo terminar com sucesso e mostrar **`Verified OK`**.
A identidade é a do workflow exato deste repositório, não apenas um prefixo
genérico de URL.

::: info Formato de assinatura
Essas releases usam os arquivos separados `.sig` e `.crt`. Versões recentes
do Cosign podem avisar que essas opções são antigas; o aviso não é uma
verificação bem-sucedida. Não use opções para ignorar o log de transparência,
o certificado ou sua identidade.
:::

## 3. Confira o arquivo baixado

Os nomes abaixo são exemplos reais da release `v22.1.0`. Substitua pelo nome
exato do arquivo da release que você escolheu; o `v` da tag não faz parte
do nome do instalador.

### Windows — PowerShell

```powershell
$arquivo = 'Monky-22.1.0-win-x64-portable.exe'
$linhas = @(Get-Content .\checksums-sha256.txt | Where-Object {
  $_ -match "^[a-fA-F0-9]{64}\s+\*?(?:\./)?$([regex]::Escape($arquivo))$"
})
if ($linhas.Count -ne 1) { throw 'Arquivo ausente ou duplicado na lista de hashes.' }
$esperado = ($linhas[0] -split '\s+')[0]
$obtido = (Get-FileHash -LiteralPath $arquivo -Algorithm SHA256).Hash
if ($obtido -ne $esperado) { throw 'Hash diferente: não instale este arquivo.' }
'SHA-256 confere.'
```

### macOS — Terminal

```bash
shasum -a 256 Monky-22.1.0-mac-arm64.dmg
```

Compare os 64 caracteres do resultado com a linha de **exatamente esse
arquivo** em `checksums-sha256.txt`. Para Mac Intel, use o arquivo `mac-x64`.

### Linux — Terminal

Para verificar os artefatos que estão nessa pasta, sem exigir o download
de todos os outros:

```bash
sha256sum --check --ignore-missing checksums-sha256.txt
```

O arquivo que você pretende usar precisa aparecer com **`OK`**. Nenhum arquivo
verificado ou qualquer divergência significa que a checagem não foi concluída.

::: warning Se alguma etapa falhar
Não instale o arquivo. Confira versão, nome e origem, baixe novamente e
investigue a falha. Um hash igual a uma lista **não autenticada** só comprova
consistência com essa lista; sozinho, não prova a origem do programa.
:::
