# Monky Light: roteiro de QA manual

[English](QA.en.md)

Este roteiro cobre o que os testes automatizados não substituem: pessoas ouvindo,
dispositivos físicos, redes reais e comparação de consumo com o Monky completo.
Registre os resultados na issue de continuidade do Light, separando **construção**,
**áudio sintético**, **hardware real** e **uso humano**.

## Regras de segurança

- Use sempre um **servidor descartável da mesma branch** e protocolo; nunca o
  servidor de produção para contornar incompatibilidade.
- Cada participante usa um perfil exclusivo: `--profile` absoluto para o Light e
  `--user-data-dir` para o cliente de desenvolvimento. Nunca aponte para os perfis
  do Monky instalado.
- Não feche a versão instalada para testar; encerre apenas processos iniciados
  pelo próprio teste.

## Preparação

1. `npm ci`, `npm run build:light` e `npm run build --workspace=apps/server`.
2. Inicie o servidor descartável com `MONKY_HOME` e porta próprios.
3. Anote em cada rodada: commit, sistema operacional e versão, CPU, dispositivos
   de áudio, rede (LAN, internet, NAT) e topologia (P2P ou SFU).

## 1. Chamada audível entre pessoas

Participantes: pelo menos uma pessoa no Light e uma no Monky completo; repita com
três ou mais pessoas. Execute tudo em **P2P e em SFU**.

| # | Passo | Esperado | P2P | SFU |
|---|---|---|---|---|
| 1.1 | Light e Monky completo entram no mesmo canal | Os dois se ouvem com clareza, sem eco perceptível | | |
| 1.2 | Terceiro participante entra | Todos ouvem todos | | |
| 1.3 | Light usa `mute` e depois desfaz | Os outros deixam de ouvir e voltam a ouvir; o Light continua ouvindo | | |
| 1.4 | Light usa `deafen` e depois desfaz | O Light para de ouvir e de transmitir; volta ao desfazer | | |
| 1.5 | Moderador aplica mute e deafen de servidor no Light | O Light respeita a restrição mesmo tentando desfazer localmente | | |
| 1.6 | Light troca de sala | Sai da sala anterior (nenhum participante fantasma) e ouve a nova | | |
| 1.7 | `reconnect` no Light durante a chamada | Volta à mesma sala e o áudio retorna | | |
| 1.8 | Moderador expulsa o Light da chamada | O Light sai e não reentra sozinho após `reconnect` | | |
| 1.9 | Administrador troca P2P ↔ SFU com a chamada ativa | A chamada continua nos dois sentidos, preservando moderação | | |
| 1.10 | Chamada de pelo menos 30 minutos | Sem cortes, atraso crescente ou robotização | | |

## 2. Dispositivos físicos

| # | Passo | Esperado | Resultado |
|---|---|---|---|
| 2.1 | `npm run test:light:hardware` | Passa com o microfone físico | |
| 2.2 | Headset USB ou Bluetooth como entrada e saída | Áudio sai e entra pelo headset | |
| 2.3 | Alterar o dispositivo padrão do sistema durante a chamada | Comportamento documentado no README; a chamada não cai | |
| 2.4 | Desconectar e reconectar o headset durante a chamada | A chamada não cai; o áudio volta ao reconectar | |
| 2.5 | Microfone bloqueado nas configurações de privacidade | Erro explícito; o Light continua recebendo áudio | |

## 3. Redes reais

| # | Cenário | Esperado | P2P | SFU |
|---|---|---|---|---|
| 3.1 | Mesma LAN | Áudio nos dois sentidos | | |
| 3.2 | Participantes em redes diferentes pela internet | Áudio nos dois sentidos | | |
| 3.3 | Um participante atrás de NAT restritivo (ex.: 4G) | Conecta via TURN quando necessário | | |
| 3.4 | TURN forçado (candidatos host/srflx bloqueados) | Conecta apenas por relay | | |
| 3.5 | Perda de pacotes de 5% e 15% e latência de 150 ms (ex.: clumsy no Windows) | Áudio inteligível; recupera quando a rede normaliza | | |
| 3.6 | Queda de rede de 10 s e 60 s | Reconecta e retorna à sala sem intervenção | | |

## 4. Consumo: Light × Monky completo

Mesmo computador, servidor, canal, topologia, participantes, dispositivos e
política de áudio. Meça **uma edição por vez**, com a outra fechada, cada fase por
pelo menos 5 minutos, com a janela do Monky completo minimizada e depois visível.

```powershell
npm run measure:client -- --name monky-light --label light-sfu --seconds 300 --output medições.jsonl
npm run measure:client -- --name Monky --label completo-sfu --seconds 300 --output medições.jsonl
```

| Fase | Light CPU (1 núcleo) | Light RAM (MiB) | Completo CPU (1 núcleo) | Completo RAM (MiB) |
|---|---|---|---|---|
| Conectado sem chamada | | | | |
| Chamada P2P (2 pessoas) | | | | |
| Chamada SFU (3 pessoas) | | | | |
| Deafen | | | | |
| Após sair da chamada | | | | |

Registre também `peakIntervalOneCoreCpuPercent`, `peakWorkingSetMiB`, número de
processos e, para uso prolongado, `npm run measure:light` com
`MONKY_LIGHT_MEASURE_SECONDS=60` e `MONKY_LIGHT_MEASURE_CYCLES=20`.

## 5. macOS (hardware real)

Execute em Intel e Apple Silicon e, se possível, no macOS 12.

| # | Passo | Esperado | Intel | Apple Silicon |
|---|---|---|---|---|
| 5.1 | `npm run build:light` e os cenários `test:light:*` | Passam | | |
| 5.2 | Permissão de microfone concedida, negada e pendente | Pedido só ao transmitir; recusa mantém mute e recepção | | |
| 5.3 | Entrar já mutado | Nenhum pedido de permissão até desmutar | | |
| 5.4 | Keychain bloqueado | Erro explícito, sem gerar outra identidade | | |
| 5.5 | Reabrir o mesmo perfil | Mesma identidade (mesmo usuário no servidor) | | |
| 5.6 | Recompilar e reabrir o mesmo perfil | Identidade preservada ou recuperação explícita | | |
| 5.7 | Conexão `ws://` na LAN e `wss://` com certificado válido | Conectam | | |
| 5.8 | `wss://` com certificado não confiável | Recusada | | |
| 5.9 | Chamada audível com o Monky completo (seção 1) | Igual ao Windows | | |
