import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import pino from 'pino';

const CONFIG_PATH = './config.json';
const WARNINGS_PATH = './warnings.json';
const AUTH_FOLDER = './auth_info';

const NOME_BOT_FANCY = '𝐟𝐚𝐦𝐢𝐥𝐢𝐚-𝟏𝟓𝟕-𝐛𝐨𝐭';

const mensagensBot = {};

// ====================== CONFIG ======================
function aplicarPadroes(c) {
    c.nomeBot ??= 'bot';
    c.prefixo ??= '!';
    c.maxAdvertencias ??= 3;
    c.acaoAposMax ??= 'remover';
    c.mensagemAdvertencia ??= 'mensagem não permitida! ⚠️ Advertência {atual}/{max}';
    c.mensagemBoasVindas ??=
        `🎉 *BEM-VINDO(A) À FAMÍLIA 157* 🎉\n` +
        `👤 {nome} acabou de entrar no grupo *{grupo}*\n` +
        `\n` +
        `📖 Leia a descrição e se divirta!`;
    c.mensagemBanAdmin ??= 'kkkkkk você não pode banir esse tchola🤷‍♂️🤣';
    c.antilink ??= true;
    c.palavrasProibidas ??= [];
    c.linkRegex ??= [];
    c.gruposPermitidos ??= [];
    c.ignorarAdmins ??= true;
    c.ignorarDono ??= true;
    c.donos ??= [];
    c.dryRun ??= false;
    c.bloquearViewOnce ??= false;
    c.cacheMetadataMs ??= 30000;
    c.fusoHorarioGrupo ??= 'Africa/Luanda';
    c.abrirGrupoHora ??= 5;
    c.fecharGrupoHora ??= 0;
    c.grupoAuto ??= true;
    return c;
}

let config = aplicarPadroes(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));

function salvarConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ====================== TEXTO / NORMALIZAÇÃO ======================
function normalizar(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function escaparRegex(txt) {
    return txt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function digitos(valor) {
    return String(valor || '').replace(/\D/g, '');
}

function semSufixo(jid) {
    return String(jid || '').split('@')[0];
}

// Constrói o "corpo" tolerante: espaço vira \s+, hífen vira separador opcional
function nucleoPalavra(palavra) {
    let s = palavra.replace(/\s+/g, '\u0000');
    s = escaparRegex(s);
    s = s.replace(/-/g, '[\\s_-]?');
    s = s.replace(/\u0000/g, '\\s+');
    return s;
}

const cachePadroes = new Map();

/**
 * Regras de casamento (evita o `includes()` que quebrava tudo):
 *   "pix"        -> palavra inteira        (NÃO pega "pixel", "fiz o pix" só se a palavra for "pix")
 *   "a se morreu"-> frase exata
 *   "*link*"     -> contém em qualquer lugar (comportamento antigo, use com cuidado)
 *   "^vk"        -> começa com
 *   "video$"     -> termina com
 *   "a.c"        -> literal (o ponto é escapado automaticamente)
 */
function regexPalavraProibida(palavra) {
    if (cachePadroes.has(palavra)) return cachePadroes.get(palavra);

    const p = normalizar(palavra);
    let re = null;

    if (p) {
        const comCuringa = p.includes('*');
        const inicio = p.startsWith('^');
        const fim = p.endsWith('$') && p.length > 1;

        let corpo = p;
        if (inicio) corpo = corpo.slice(1);
        if (fim) corpo = corpo.slice(0, -1);
        corpo = corpo.replace(/\*/g, '').replace(/\s+/g, ' ').trim();

        if (corpo) {
            const nuc = nucleoPalavra(corpo);
            const palavraSimples = !corpo.includes(' ');
            const bordaEsq = '(?<![\\p{L}\\p{N}])';
            const bordaDir = '(?![\\p{L}\\p{N}])';

            let padrao;
            if (comCuringa && palavraSimples) padrao = `\\p{L}*${nuc}[\\p{L}\\p{N}]*`;
            else if (comCuringa) padrao = nuc;
            else if (inicio) padrao = `${bordaEsq}${nuc}${bordaDir}`;
            else if (fim) padrao = `${bordaEsq}\\p{L}*${nuc}${bordaDir}`;
            else padrao = `${bordaEsq}${nuc}${bordaDir}`;

            try {
                re = new RegExp(padrao, 'iu');
            } catch {
                re = null;
            }
        }
    }

    cachePadroes.set(palavra, re);
    return re;
}

function contemLink(texto) {
    for (const pattern of config.linkRegex) {
        try {
            if (new RegExp(pattern, 'i').test(texto)) return pattern;
        } catch { /* padrão inválido é ignorado */ }
    }
    return null;
}

function contemConteudoProibido(texto) {
    if (!texto) return { proibido: false };

    if (config.antilink) {
        const link = contemLink(texto);
        if (link) return { proibido: true, motivo: `link (${link})` };
    }

    const alvo = normalizar(texto);
    for (const palavra of config.palavrasProibidas) {
        const re = regexPalavraProibida(palavra);
        if (re && re.test(alvo)) return { proibido: true, motivo: `palavra: "${palavra}"` };
    }

    return { proibido: false };
}

function validarPadroesLink() {
    const suspeitos = [];
    for (const p of config.linkRegex) {
        if (/(^|[^\\])[.]\p{L}/u.test(p)) {
            const seguro = /^(https?:\/\/|www)\.?\/?$/u.test(p);
            if (!seguro) suspeitos.push(p);
        }
    }
    if (suspeitos.length) {
        console.log(' [!] linkRegex com ponto NÃO escapado (vira coringa e apaga texto inocente):', suspeitos.join(', '));
        console.log('     Ex.: "t\\.me" e NÃO "t.me"');
    }
}

// ====================== PERSISTÊNCIA ======================
function carregarWarnings() {
    if (!fs.existsSync(WARNINGS_PATH)) {
        fs.writeFileSync(WARNINGS_PATH, JSON.stringify({}, null, 2));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(WARNINGS_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function salvarWarnings(data) {
    fs.writeFileSync(WARNINGS_PATH, JSON.stringify(data, null, 2));
}

// ====================== IDENTIDADE (LID <-> PN) ======================
let sockAtual = null;
const cacheMetadata = new Map();
const aliasPorGrupo = new Map(); // jid -> Map(chave -> [aliases])

async function pegarMetadata(sock, jid) {
    const cached = cacheMetadata.get(jid);
    if (cached && Date.now() - cached.ts < config.cacheMetadataMs) return cached.data;
    const data = await sock.groupMetadata(jid);
    cacheMetadata.set(jid, { data, ts: Date.now() });
    return data;
}

function registrarAliases(jid, participants) {
    const mapa = new Map();
    for (const p of participants || []) {
        const chaves = [p.id, p.lid, p.phoneNumber].filter(Boolean);
        for (const c of chaves) mapa.set(semSufixo(c), chaves);
    }
    aliasPorGrupo.set(jid, mapa);
    return mapa;
}

const autoGrupoFeito = new Map();
let timerGrupoAuto = null;
let sockGrupoAuto = null;

function partesNaZona(agora, zona) {
    try {
        const partes = {};
        new Intl.DateTimeFormat('en-CA', {
            timeZone: zona,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(agora).forEach(p => { partes[p.type] = p.value; });
        return {
            data: `${partes.year}-${partes.month}-${partes.day}`,
            hora: Number(partes.hour),
            minuto: Number(partes.minute)
        };
    } catch {
        return null;
    }
}

function acaoGrupoAgendada(hora, minuto, abrirHora, fecharHora) {
    if (!Number.isInteger(hora) || !Number.isInteger(minuto)) return null;
    if (!Number.isInteger(abrirHora) || !Number.isInteger(fecharHora)) return null;
    if (abrirHora === fecharHora) return null;
    if (minuto !== 0) return null;
    if (hora === abrirHora) return 'aberta';
    if (hora === fecharHora) return 'fechada';
    return null;
}

async function aplicarAgendamentoGrupo(sock, agora = new Date()) {
    if (!config.grupoAuto) return [];
    const partes = partesNaZona(agora, config.fusoHorarioGrupo);
    if (!partes) return [];
    const acao = acaoGrupoAgendada(partes.hora, partes.minuto, config.abrirGrupoHora, config.fecharGrupoHora);
    if (!acao) return [];

    const grupos = await sock.groupFetchAllParticipating();
    const resultados = [];
    for (const grupoJid of Object.keys(grupos || {})) {
        const chave = `${grupoJid}|${partes.data}|${acao}`;
        if (autoGrupoFeito.has(chave)) continue;
        try {
            const metadata = await pegarMetadata(sock, grupoJid);
            const travado = metadata?.announce === true;
            const desejaTravar = acao === 'fechada';
            if (travado === desejaTravar) {
                autoGrupoFeito.set(chave, Date.now());
                resultados.push({ grupo: grupoJid, acao, aplicada: false, motivo: 'ja-no-estado' });
                continue;
            }
            await sock.groupSettingUpdate(grupoJid, desejaTravar ? 'announcement' : 'not_announcement');
            await sock.sendMessage(grupoJid, {
                text: desejaTravar
                    ? `🔒 *GRUPO FECHADO!*\n\nSó os administradores podem falar agora. Boa noite! 🌙\n\nTambém dá para controlar com \`${config.prefixo}abrir\` e \`${config.prefixo}fechar\`.`
                    : `🔓 *GRUPO ABERTO!*\n\nTodo mundo pode falar de novo. Bom dia! ☀️\n\nTambém dá para controlar com \`${config.prefixo}abrir\` e \`${config.prefixo}fechar\`.`
            });
            autoGrupoFeito.set(chave, Date.now());
            resultados.push({ grupo: grupoJid, acao, aplicada: true });
        } catch (e) {
            resultados.push({ grupo: grupoJid, acao, aplicada: false, motivo: e?.message || String(e) });
        }
    }

    if (autoGrupoFeito.size > 500) {
        const limite = Date.now() - 36 * 60 * 60 * 1000;
        for (const [chave, quando] of autoGrupoFeito) {
            if (quando < limite) autoGrupoFeito.delete(chave);
        }
    }
    return resultados;
}

function iniciarAgendamentoGrupo(sock) {
    sockGrupoAuto = sock;
    if (timerGrupoAuto) return;
    const verificar = () => {
        if (!sockGrupoAuto) return;
        aplicarAgendamentoGrupo(sockGrupoAuto).catch(e => console.log('Erro no agendamento do grupo:', e?.message || e));
    };
    verificar();
    timerGrupoAuto = setInterval(verificar, 20000);
}

function aliasesDe(jid, ref) {
    if (!ref) return [];
    const mapa = aliasPorGrupo.get(jid);
    const achado = mapa?.get(semSufixo(ref));
    return achado ? achado.filter(x => x !== ref) : [];
}

function acharParticipante(participants, ref) {
    if (!ref) return null;
    const base = semSufixo(ref);
    const num = digitos(ref);
    return (
        participants.find(p =>
            p.id === ref || p.lid === ref || p.phoneNumber === ref ||
            semSufixo(p.id) === base ||
            (p.lid && semSufixo(p.lid) === base) ||
            (p.phoneNumber && semSufixo(p.phoneNumber) === base)
        ) ||
        (num
            ? participants.find(p =>
                (p.phoneNumber && digitos(p.phoneNumber) === num) ||
                (p.id && digitos(p.id) === num && p.id.includes('@s.whatsapp.net'))
            )
            : null) ||
        null
    );
}

function ehAdmin(participants, jid) {
    const p = acharParticipante(participants, jid);
    if (!p) return false;
    return p.admin === 'admin' || p.admin === 'superadmin';
}

/** Chave canônica de advertência: sempre o mesmo id, mesmo se o WA mandar PN ou LID. */
function chaveCanonica(jid, sender, participants) {
    const p = acharParticipante(participants, sender);
    return p?.id || sender;
}

/**
 * O WhatsApp entrega o LID (identificador interno), não o telefone. Comparar o
 * `digitos()` do LID com o número do config nunca bateria, então resolvemos o
 * participante e comparamos telefone E LID.
 */
function ehDono(ref, participants) {
    if (!config.ignorarDono || !config.donos?.length) return false;
    const p = acharParticipante(participants, ref);
    const cands = [ref, p?.id, p?.lid, p?.phoneNumber].filter(Boolean).map(digitos).filter(Boolean);
    const lista = config.donos.map(digitos).filter(Boolean);
    return cands.some(c => lista.includes(c));
}

/** Link de convite do grupo. Devolve null se o bot nao conseguir (permissao). */
async function linkDoGrupo(sock, jid) {
    try {
        const code = await sock.groupInviteCode(jid);
        return code ? `https://chat.whatsapp.com/${code}` : null;
    } catch {
        return null;
    }
}

function ehProtegido(sock, sender, participants) {
    if (!sender) return true;
    const botId = sock.user?.id;
    const botLid = sock.user?.lid;
    if (sender === botId || sender === botLid) return true;
    if (botId && semSufixo(sender) === semSufixo(botId)) return true;

    if (ehDono(sender, participants)) return true;

    if (config.ignorarAdmins && ehAdmin(participants, sender)) return true;

    return false;
}

// ====================== AÇÕES DE MODERAÇÃO ======================
async function apagarMensagem(sock, jid, key) {
    if (!key?.id) return { ok: false, erro: 'mensagem sem id' };
    try {
        await sock.sendMessage(jid, { delete: key });
        return { ok: true };
    } catch (e) {
        return { ok: false, erro: e.message };
    }
}

/** Reconhece o tipo de mídia, desembrulhando view-once/efêmera. */
function tipoDaMidia(m) {
    if (!m) return null;
    const embrulho =
        m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message?.message ||
        m.viewOnceMessageV2?.message ||
        m.viewOnceMessageV2Extension?.message ||
        m.ephemeralMessage?.message;
    if (embrulho && embrulho !== m) return tipoDaMidia(embrulho);
    if (m.imageMessage) return m.imageMessage.viewOnce ? 'imagem-efemera' : 'imagem';
    if (m.videoMessage) return m.videoMessage.viewOnce ? 'video-efemero' : 'video';
    if (m.stickerMessage) return 'figurinha';
    if (m.audioMessage) return 'audio';
    if (m.documentMessage) return 'documento';
    if (m.contactMessage) return 'contato';
    if (m.locationMessage || m.liveLocationMessage) return 'localizacao';
    if (m.pollCreationMessage) return 'enquete';
    if (m.conversation || m.extendedTextMessage) return 'texto';
    return null;
}

const TIPOS_MIDIA = ['imagem', 'imagem-efemera', 'video', 'video-efemero', 'figurinha', 'documento'];

/**
 * Key da mensagem citada. Usa a key original guardada no cache (tem o participant
 * correto, o WhatsApp exige) e só remonta como último recurso.
 */
function chaveCitada(ctx, jid, participants) {
    if (!ctx?.stanzaId) return null;
    const guardada = cacheKeys.get(`${jid}|${ctx.stanzaId}`);
    if (guardada) {
        return {
            remoteJid: guardada.remoteJid || jid,
            id: guardada.id,
            fromMe: guardada.fromMe,
            participant: guardada.participant
        };
    }
    const p = ctx.participant ? acharParticipante(participants || [], ctx.participant) : null;
    return { remoteJid: jid, id: ctx.stanzaId, fromMe: false, participant: p?.id || ctx.participant || undefined };
}

/**
 * Fluxo único de punição: apaga -> conta advertência -> avisa -> bane no limite.
 * Se `key` for null, só conta advertência (sem apagar nada).
 */
async function aplicarAdvertencia(sock, jid, alvo, motivo, key) {
    console.log(` [DETECTADO] ${alvo} (${digitos(alvo) || semSufixo(alvo)}) | motivo: ${motivo}`);

    if (config.dryRun) {
        console.log('  -> dryRun: não apagou, não advertiu');
        return { apagada: false, atual: 0, dryRun: true };
    }

    if (key) {
        const r = await apagarMensagem(sock, jid, key);
        if (r.ok) {
            console.log('  -> Mensagem apagada');
        } else {
            console.log('  -> Erro ao apagar (bot precisa ser admin):', r.erro);
            return { apagada: false, erro: r.erro, atual: 0 };
        }
    }

    const warnings = carregarWarnings();
    if (!warnings[jid]) warnings[jid] = {};
    unificarWarnings(warnings, jid, alvo, aliasesDe(jid, alvo));
    warnings[jid][alvo] = (warnings[jid][alvo] || 0) + 1;
    const atual = warnings[jid][alvo];
    salvarWarnings(warnings);

    let texto = config.mensagemAdvertencia
        .replace('{atual}', atual)
        .replace('{max}', config.maxAdvertencias);

    if (atual === config.maxAdvertencias - 1) {
        texto += `\n\n⚠️ *NA PRÓXIMA VAI LEVAR BAN!*`;
    }

    await sock.sendMessage(jid, {
        text: `⛔ @${semSufixo(alvo)} ${texto}`,
        mentions: [alvo]
    });

    if (atual >= config.maxAdvertencias) {
        if (config.acaoAposMax === 'remover') {
            await new Promise(r => setTimeout(r, 1000));
            try {
                await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
                await sock.sendMessage(jid, {
                    text: `🚫 @${semSufixo(alvo)} removido após ${config.maxAdvertencias} advertências.`,
                    mentions: [alvo]
                });
                console.log(`  -> Usuário ${alvo} removido`);
            } catch (e) {
                console.log('  -> Erro ao remover usuário (bot precisa ser admin):', e.message);
            }
        }
        warnings[jid][alvo] = 0;
        salvarWarnings(warnings);
    }

    return { apagada: true, atual };
}

// ====================== ANTI-DUPLICIDADE ======================
const processados = new Set();
const filaProcessados = [];
// Guarda a key EXATA de cada mensagem recebida. Sem isso, o !apagar precisa
// remontar a key pelo contextInfo e perde o participant -> WhatsApp ignora o delete.
const cacheKeys = new Map();

function guardarKey(jid, key) {
    const id = `${jid}|${key.id}`;
    cacheKeys.set(id, key);
    if (cacheKeys.size > 2000) cacheKeys.delete(cacheKeys.keys().next().value);
    return id;
}

function jaProcessou(key) {
    const id = `${key.remoteJid}|${key.id}|${key.participant || ''}`;
    if (processados.has(id)) return true;
    processados.add(id);
    filaProcessados.push(id);
    if (filaProcessados.length > 2000) processados.delete(filaProcessados.shift());
    return false;
}

/** Mescla contadores gravados sob chaves LID/PN diferentes (o WA alterna entre os dois). */
function unificarWarnings(warnings, jid, canonica, aliases) {
    if (!warnings[jid]) return 0;
    let maior = warnings[jid][canonica] || 0;
    for (const a of aliases) {
        if (a === canonica) continue;
        maior = Math.max(maior, warnings[jid][a] || 0);
        delete warnings[jid][a];
    }
    warnings[jid][canonica] = maior;
    return maior;
}

// ====================== BOT ======================
async function iniciarBot() {
    // Mata o socket anterior para não duplicar listeners (banho de advertência em cascata)
    if (sockAtual?.ev) {
        try { sockAtual.ev.removeAllListeners(); } catch { /* noop */ }
        try { sockAtual.ws?.close(); } catch { /* noop */ }
        sockAtual = null;
    }

    if (process.env.AUTH_B64) {
        try {
            if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
            const credsJson = Buffer.from(process.env.AUTH_B64, 'base64').toString('utf-8');
            JSON.parse(credsJson);
            fs.writeFileSync(`${AUTH_FOLDER}/creds.json`, credsJson);
            console.log(' Sessão restaurada via AUTH_B64');
        } catch (e) {
            console.log(' Erro ao restaurar sessão AUTH_B64:', e.message);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    console.log(' Versão WA usada:', version.join('.'));

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        getMessage: async () => undefined
    });
    sockAtual = sock;

    validarPadroesLink();

    sock.ev.on('creds.update', saveCreds);

    const numeroPareamento = String(process.env.NUMERO_BOT || config.numeroBot || '').replace(/\D/g, '');
    let pareamentoSolicitado = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const semIdentidade = !sock.authState.creds.me;
            if (numeroPareamento && semIdentidade && !sock.authState.creds.registered && !pareamentoSolicitado) {
                pareamentoSolicitado = true;
                try {
                    const code = await sock.requestPairingCode(numeroPareamento);
                    console.log(`\n CÓDIGO DE PAREAMENTO: ${code}`);
                    console.log(' No WhatsApp do bot: Aparelhos conectados > Conectar um aparelho > Conectar com número de telefone');
                } catch (e) {
                    console.log(' Erro ao gerar código de pareamento:', e.message);
                    pareamentoSolicitado = false;
                }
            } else if (!numeroPareamento) {
                console.log('\n Escaneie o QR Code abaixo com o WhatsApp:');
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === 'open') {
            cacheMetadata.clear();
            console.log(`\n Bot "${config.nomeBot}" conectado com sucesso!`);
            console.log(` Prefixo: ${config.prefixo} | Max advertências: ${config.maxAdvertencias} | Dry-run: ${config.dryRun ? 'ON' : 'OFF'}`);
            iniciarAgendamentoGrupo(sock);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errMsg = lastDisconnect?.error?.message;
            console.log(` Conexão fechada. status=${statusCode} erro=${errMsg}`);
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(' Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => iniciarBot().catch(e => console.log('Erro ao reconectar:', e.message)), 3000);
            }
        }
    });

    sock.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            cacheMetadata.delete(id);
            aliasPorGrupo.delete(id);
            console.log(` [BOAS-VINDAS] evento ${action} em ${id}: ${JSON.stringify(participants)}`);
            if (action !== 'add' || !Array.isArray(participants) || !participants.length) return;

            let metadata = null;
            try {
                metadata = await sock.groupMetadata(id);
                registrarAliases(id, metadata.participants);
            } catch (e) {
                console.log(` [BOAS-VINDAS] sem metadata de ${id}: ${e?.message || e}`);
            }
            const groupName = metadata?.subject || 'o grupo';

            for (const ref of participants) {
                try {
                    const p = metadata ? acharParticipante(metadata.participants, ref) : null;
                    const alvoId = p?.id || ref;
                    const nome = p?.name || p?.notifyName || semSufixo(alvoId);
                    const pn = p?.phoneNumber || (String(alvoId).endsWith('@s.whatsapp.net') ? alvoId : null);
                    const texto = config.mensagemBoasVindas
                        .replace(/{nome}/g, nome)
                        .replace(/{grupo}/g, groupName);

                    // Menção por LID (@lid) derruba o envio com 400, e menção vazia
                    // também. Só marca quando temos o telefone; senão texto puro.
                    try {
                        if (pn) await sock.sendMessage(id, { text: texto, mentions: [pn] });
                        else await sock.sendMessage(id, { text: texto });
                    } catch (e) {
                        console.log(` [BOAS-VINDAS] menção falhou (${e?.message || e}), mandando texto puro`);
                        await sock.sendMessage(id, { text: texto });
                    }
                    console.log(` [BOAS-VINDAS] ${alvoId} em ${id} | nome=${nome}`);
                } catch (e) {
                    console.log(` [BOAS-VINDAS] falhou para ${ref} em ${id}: ${e?.message || e}`);
                }
            }
        } catch (e) {
            console.log('Erro no boas-vindas:', e.message);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (msg.key.fromMe && msg.key.remoteJid) {
                    const jidBot = msg.key.remoteJid;
                    if (!mensagensBot[jidBot]) mensagensBot[jidBot] = [];
                    mensagensBot[jidBot].push(msg.key);
                    if (mensagensBot[jidBot].length > 60) mensagensBot[jidBot].shift();
                    continue;
                }

                if (!msg.message) continue;

                // O WA reenvia mensagens antigas no reconnect -> contava advertência 2x
                if (jaProcessou(msg.key)) continue;

                const jid = msg.key.remoteJid;
                if (!jid || !jid.endsWith('@g.us')) continue;

                guardarKey(jid, msg.key);

                if (config.gruposPermitidos.length > 0 && !config.gruposPermitidos.includes(jid)) continue;

                const texto = getTextoMensagem(msg);
                const senderBruto = msg.key.participant || msg.key.senderPn || msg.participant;
                if (!senderBruto) continue;

                const metadata = await pegarMetadata(sock, jid);
                registrarAliases(jid, metadata.participants);

                const sender = chaveCanonica(jid, senderBruto, metadata.participants);

                // Mídia "ver uma vez" é o esconderijo clássico de conteúdo adulto.
                // Checagem independente de texto: foto view-once COM legenda também cai aqui.
                if (config.bloquearViewOnce) {
                    const tipo = tipoDaMidia(msg.message);
                    if (tipo === 'imagem-efemera' || tipo === 'video-efemero') {
                        if (ehProtegido(sock, sender, metadata.participants)) continue;
                        await aplicarAdvertencia(sock, jid, sender, `${tipo} (ver uma vez)`, msg.key);
                        continue;
                    }
                }

                if (!texto) continue;

                if (texto.startsWith(config.prefixo)) {
                    await handleComandos(sock, msg, jid, texto, sender, metadata);
                    continue;
                }

                if (ehProtegido(sock, sender, metadata.participants)) continue;

                const check = contemConteudoProibido(texto);
                if (!check.proibido) continue;

                await aplicarAdvertencia(sock, jid, sender, check.motivo, msg.key);
            } catch (err) {
                console.error('Erro ao processar mensagem:', err);
            }
        }
    });
}

// ====================== COMANDOS ======================
async function handleComandos(sock, msg, jid, texto, sender, metadata) {
    const args = texto.slice(config.prefixo.length).trim().split(/ +/);
    const comando = args.shift().toLowerCase();
    if (!comando) return;

    const isAdmin = ehAdmin(metadata.participants, sender);
    const botId = sock.user.id;
    const botP = acharParticipante(metadata.participants, botId) || acharParticipante(metadata.participants, sock.user.lid);
    const isBotAdmin = botP?.admin === 'admin' || botP?.admin === 'superadmin';

    const reply = (t, mentions) =>
        sock.sendMessage(jid, mentions ? { text: t, mentions } : { text: t }, { quoted: msg });

    if (comando === 'addpalavra' || comando === 'addword') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const palavra = normalizar(args.join(' '));
        if (!palavra) return reply(`Uso: ${config.prefixo}addpalavra <palavra>`);
        if (config.palavrasProibidas.some(p => normalizar(p) === palavra)) return reply('⚠️ Essa palavra já está na lista.');
        config.palavrasProibidas.push(palavra);
        cachePadroes.clear();
        salvarConfig();
        return reply(`✅ Palavra "${palavra}" adicionada (palavra inteira).`);
    }

    if (comando === 'rmpalavra' || comando === 'removepalavra') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const palavra = normalizar(args.join(' '));
        const idx = config.palavrasProibidas.findIndex(p => normalizar(p) === palavra);
        if (idx === -1) return reply('⚠️ Palavra não encontrada.');
        config.palavrasProibidas.splice(idx, 1);
        cachePadroes.clear();
        salvarConfig();
        return reply(`✅ Palavra "${palavra}" removida.`);
    }

    if (comando === 'listapalavras' || comando === 'listwords') {
        const lista = config.palavrasProibidas.join(', ') || '(nenhuma)';
        return reply(`📋 Palavras proibidas:\n${lista}\n\nAntilink: ${config.antilink ? 'ON' : 'OFF'}`);
    }

    if (comando === 'teste' || comando === 'test') {
        const amostra = args.join(' ');
        if (!amostra) return reply(`Uso: ${config.prefixo}teste <texto> — mostra o que o bot detectaria`);
        const check = contemConteudoProibido(amostra);
        return reply(check.proibido
            ? `🚨 SERIA APAGADO — motivo: ${check.motivo}`
            : `✅ Passaria limpinho, não seria apagado.`);
    }

    if (comando === 'antilink') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const opt = args[0]?.toLowerCase();
        if (opt === 'on') config.antilink = true;
        else if (opt === 'off') config.antilink = false;
        else return reply(`Uso: ${config.prefixo}antilink on/off (atual: ${config.antilink ? 'ON' : 'OFF'})`);
        salvarConfig();
        return reply(`✅ Antilink: ${config.antilink ? 'ATIVADO' : 'DESATIVADO'}`);
    }

    if (comando === 'advertencias' || comando === 'warns') {
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const alvoBruto = ctx?.mentionedJid?.[0] || ctx?.participant || sender;
        const alvo = chaveCanonica(jid, alvoBruto, metadata.participants);
        const warnings = carregarWarnings();
        const qtd = warnings[jid]?.[alvo] || 0;
        return reply(`⚠️ @${semSufixo(alvo)} tem ${qtd}/${config.maxAdvertencias} advertências.`, [alvo]);
    }

    if (comando === 'zerar' || comando === 'resetwarn') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const alvoBruto = ctx?.mentionedJid?.[0] || ctx?.participant;
        if (!alvoBruto) return reply(`Uso: ${config.prefixo}zerar @usuario ou responda a mensagem dele com ${config.prefixo}zerar`);
        const alvo = chaveCanonica(jid, alvoBruto, metadata.participants);
        const warnings = carregarWarnings();
        if (!warnings[jid]) warnings[jid] = {};
        unificarWarnings(warnings, jid, alvo, aliasesDe(jid, alvo));
        warnings[jid][alvo] = 0;
        salvarWarnings(warnings);
        return reply(`✅ Advertências de @${semSufixo(alvo)} zeradas.`, [alvo]);
    }

    if (comando === 'apagar' || comando === 'del' || comando === 'deletar') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        if (!isBotAdmin) return reply('❌ Eu não sou admin aqui, então o WhatsApp não deixa eu apagar mensagem de outra pessoa.');
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId) return reply(`↩️ Responda a mensagem que quer apagar com ${config.prefixo}apagar`);
        const tipo = tipoDaMidia(ctx.quotedMessage) || 'mensagem';
        const key = chaveCitada(ctx, jid, metadata.participants);
        const doCache = cacheKeys.has(`${jid}|${ctx.stanzaId}`);
        console.log(` [APAGAR] tipo=${tipo} key=${JSON.stringify(key)} doCache=${doCache}`);

        const r = await apagarMensagem(sock, jid, key);
        if (!r.ok) {
            console.log(` [APAGAR] falhou: ${r.erro}`);
            return reply('❌ Não consegui apagar. O bot precisa ser admin do grupo.');
        }
        if (!doCache) {
            return reply(`🗑️ Pedido enviado (${tipo}).\n⚠️ Não achei a mensagem no cache: se ela for antiga ou tiver vindo antes do bot reiniciar, o WhatsApp pode ignorar.`);
        }
        return reply(`🗑️ Apagada (${tipo}).`);
    }

    if (comando === '+18' || comando === 'adulto' || comando === 'nsfw' || comando === 'porn') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId) return reply(`↩️ Responda a foto/vídeo com ${config.prefixo}+18`);

        const tipo = tipoDaMidia(ctx.quotedMessage);
        if (!tipo || !TIPOS_MIDIA.includes(tipo)) {
            return reply(`Isso não é mídia (é ${tipo || 'desconhecido'}). Usa ${config.prefixo}apagar pra só apagar.`);
        }

        const autorBruto = ctx.participant;
        if (!autorBruto) return reply('❌ Não consegui identificar quem mandou a mídia.');

        const alvo = chaveCanonica(jid, autorBruto, metadata.participants);
        if (alvo === sender) return reply('❌ Essa mídia é sua, não vou me auto-punir.');
        if (ehProtegido(sock, alvo, metadata.participants)) return reply('❌ Não vou punir admin/dono por isso.');

        const res = await aplicarAdvertencia(sock, jid, alvo, `conteúdo +18 (${tipo})`, chaveCitada(ctx, jid, metadata.participants));
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch { /* opcional */ }

        if (res.dryRun) return reply(`🧪 DRY-RUN: teria apagado a ${tipo} e dado advertência para @${semSufixo(alvo)}.`);
        if (res.erro) return reply(`❌ Mídia NÃO apagada (${res.erro}) e advertência não contada.`);
        return;
    }

    if (comando === 'ban') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const alvoBruto = ctx?.mentionedJid?.[0] || ctx?.participant;
        if (!alvoBruto) return reply(`Uso: ${config.prefixo}ban @usuario ou responda a mensagem dele com ${config.prefixo}ban`);
        const alvo = chaveCanonica(jid, alvoBruto, metadata.participants);
        if (alvo === sender) return reply('❌ Você não pode se banir kkk');
        if (alvo === sock.user.id || alvo === sock.user.lid) return reply('❌ Não vou me banir kkk');

        // Admin não cai: só o dono do bot consegue remover outro admin
        if (ehAdmin(metadata.participants, alvo) && !ehDono(sender, metadata.participants)) {
            return reply(config.mensagemBanAdmin);
        }

        try {
            await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
            return reply(`🚫 @${semSufixo(alvo)} foi banido do grupo.`, [alvo]);
        } catch {
            return reply('❌ Erro ao banir. Verifica se o bot é admin.');
        }
    }

    if (comando === 'limpar') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const keys = mensagensBot[jid] || [];
        if (keys.length === 0) return reply('🗑️ Nenhuma mensagem minha pra apagar aqui.');
        let deletadas = 0;
        for (const k of keys) {
            try {
                await sock.sendMessage(jid, { delete: k });
                deletadas++;
            } catch { /* já apagada / sem permissão */ }
        }
        mensagensBot[jid] = [];
        return reply(`🗑️ ${deletadas} mensagens apagadas.`);
    }

    if (comando === 's' || comando === 'sticker' || comando === 'fig' || comando === 'figurinha') {
        try {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            let mediaMsg = null;

            if (msg.message?.imageMessage) {
                mediaMsg = msg;
            } else if (quoted?.imageMessage) {
                mediaMsg = { key: msg.key, message: quoted };
            } else if (msg.message?.videoMessage || quoted?.videoMessage) {
                return reply('❌ Figurinha de vídeo ainda não suportada. Manda uma imagem.');
            } else if (quoted?.stickerMessage) {
                return reply('❌ Não dá pra converter sticker em sticker.');
            }

            if (!mediaMsg) return reply(`Uso: envie uma imagem com legenda ${config.prefixo}s ou responda uma imagem com ${config.prefixo}s`);

            const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });

            let sharpLib;
            try {
                sharpLib = (await import('sharp')).default;
            } catch {
                return reply('❌ Figurinha indisponível no momento.');
            }
            const webp = await sharpLib(buffer).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer();

            await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
            return;
        } catch (e) {
            console.log('Erro sticker:', e.message);
            return reply('❌ Erro ao criar figurinha. Tente com uma imagem normal.');
        }
    }

    // Fecha/abre a conversa do grupo: só ADMs falam quando fechado. O bot
    // precisa ser admin do grupo. Serve pra calar o grupo de madrugada.
    if (['fechar', 'fecharg', 'fechargrupo', 'trancar', 'lock', 'silenciar'].includes(comando)) {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        try {
            await sock.groupSettingUpdate(jid, 'announcement');
            return reply(
                `🔒 *GRUPO FECHADO!*\n\n` +
                `Só os administradores podem falar agora.\n` +
                `📢 Aviso: o grupo volta a abrir com \`${config.prefixo}abrir\`.`
            );
        } catch (e) {
            return reply(
                `❌ *Não consegui fechar o grupo.*\n\n` +
                `_${e?.message || e}_\n\n` +
                `O bot precisa ser *admin* do grupo pra travar.`
            );
        }
    }

    if (['abrirg', 'abrirgrupo', 'destrancar', 'unlock', 'abrir'].includes(comando)) {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        try {
            await sock.groupSettingUpdate(jid, 'not_announcement');
            return reply(
                `🔓 *GRUPO ABERTO!*\n\n` +
                `Todo mundo pode falar de novo. Bom dia! ☀️`
            );
        } catch (e) {
            return reply(
                `❌ *Não consegui abrir o grupo.*\n\n` +
                `_${e?.message || e}_\n\n` +
                `O bot precisa ser *admin* do grupo pra destravar.`
            );
        }
    }

    if (comando === 'ping') {
        return reply('🏓 Pong! Bot online.');
    }

    if (comando === 'status') {
        return reply(
            `🩺 Status do bot\n` +
            `Palavras: ${config.palavrasProibidas.length} | Antilink: ${config.antilink ? 'ON' : 'OFF'}\n` +
            `Sou admin aqui: ${isBotAdmin ? 'sim' : 'NÃO'}${isBotAdmin ? '' : ' (não apago nem bano)'}\n` +
            `Ignorar admins: ${config.ignorarAdmins ? 'ON' : 'OFF'} | Ignorar dono: ${config.ignorarDono ? 'ON' : 'OFF'}`
        );
    }

    if (comando === 'ajuda' || comando === 'help' || comando === 'menu') {
        const menu =
            `*🤖 ${NOME_BOT_FANCY} - Menu de Comandos* 🤖\n` +
            `\n` +
            `🧹 *LIMPEZA*\n` +
            `🗑️ \`${config.prefixo}apagar\` - Apaga a msg respondida\n` +
            `🧹 \`${config.prefixo}limpar\` - Apaga as msgs do bot\n` +
            `\n` +
            `🚨 *PUNIÇÕES*\n` +
            `🔞 \`${config.prefixo}+18\` - Apaga foto/vídeo + adverte\n` +
            `🚫 \`${config.prefixo}ban\` - Bane (marca ou responde)\n` +
            `♻️ \`${config.prefixo}zerar @usuario\` - Zera advertências\n` +
            `⚠️ \`${config.prefixo}advertencias\` - Vê advertências\n` +
            `\n` +
            `📝 *PALAVRAS*\n` +
            `➕ \`${config.prefixo}addpalavra <p>\` - Bloqueia palavra\n` +
            `➖ \`${config.prefixo}rmpalavra <p>\` - Libera palavra\n` +
            `📋 \`${config.prefixo}listapalavras\` - Ver bloqueadas\n` +
            `🧪 \`${config.prefixo}teste <texto>\` - Simula a detecção\n` +
            `\n` +
            `⚙️ *AJUSTES*\n` +
            `🔗 \`${config.prefixo}antilink on/off\` - Liga/desliga anti-link\n` +
            `🔒 \`${config.prefixo}fechar\` - Fecha o grupo (só ADMs falam)\n` +
            `🔓 \`${config.prefixo}abrir\` - Abre o grupo\n` +
            `⏰ Auto: abre 5h e fecha 0h (Angola)\n` +
            `\n` +
            `📡 *GERAL* 📡\n` +
            `🖼️ \`${config.prefixo}s\` - Cria figurinha\n` +
            `🏓 \`${config.prefixo}ping\` - Testa se o bot está online\n` +
            `🩺 \`${config.prefixo}status\` - Diagnóstico do bot\n` +
            `❓ \`${config.prefixo}ajuda\` - Mostra este menu`;

        if (isAdmin) return reply(menu);

        return reply(
            `*🤖 ${NOME_BOT_FANCY} - Menu de Comandos* 🤖\n` +
            `\n` +
            `👥 *MEMBROS* 👥\n` +
            `📋 \`${config.prefixo}listapalavras\` - Lista palavras bloqueadas\n` +
            `🧪 \`${config.prefixo}teste <texto>\` - Simula a detecção\n` +
            `⚠️ \`${config.prefixo}advertencias\` - Vê advertências\n` +
            `\n` +
            `📡 *GERAL* 📡\n` +
            `🖼️ \`${config.prefixo}s\` - Cria figurinha\n` +
            `🏓 \`${config.prefixo}ping\` - Testa se o bot está online\n` +
            `🩺 \`${config.prefixo}status\` - Diagnóstico do bot\n` +
            `❓ \`${config.prefixo}ajuda\` - Mostra este menu`
        );
    }
}

iniciarBot().catch(e => console.log('Erro fatal ao iniciar:', e));
