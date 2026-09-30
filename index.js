import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import pino from 'pino';

const CONFIG_PATH = './config.json';
const WARNINGS_PATH = './warnings.json';
const RANK_PATH = './rank.json';
const CASSINO_PATH = './cassino.json';
const CONVITES_PATH = './convites.json';
const BONUS_PATH = './bonus.json';
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
        `👋 @{nome} acabou de entrar no grupo *{grupo}*\n` +
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
    c.cassinoAtivo ??= true;
    c.apostaMinima ??= 1;
    c.saldoInicial ??= 10;
    c.convidadosNecessarios ??= 2;
    c.bonusDiario ??= 2;
    c.fichasPorConvidado ??= 10;
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

const NUMEROS_PT = {
    zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
    seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
    treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16,
    dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20
};

function extrairInteiro(tokens) {
    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = String(tokens[i] || '');
        const dig = token.replace(/[^0-9-]/g, '');
        if (/^-?\d+$/.test(dig)) return parseInt(dig, 10);
        const palavra = normalizar(token);
        if (Object.hasOwn(NUMEROS_PT, palavra)) return NUMEROS_PT[palavra];
    }
    return null;
}

function acharParticipantePorTexto(participants, texto) {
    const limpo = String(texto || '').replace(/^@/, '').trim();
    if (!limpo) return null;
    const num = digitos(limpo);
    if (num.length >= 5) {
        const porNumero = acharParticipante(participants, num);
        if (porNumero) return porNumero;
    }
    const alvo = normalizar(limpo);
    return (participants || []).find(p => {
        const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(x => normalizar(semSufixo(x)));
        return ids.some(id => id && (id === alvo || id.endsWith(alvo) || alvo.endsWith(id)));
    }) || null;
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

function carregarRank() {
    if (!fs.existsSync(RANK_PATH)) {
        fs.writeFileSync(RANK_PATH, JSON.stringify({}, null, 2));
        return {};
    }
    return JSON.parse(fs.readFileSync(RANK_PATH, 'utf-8'));
}

function salvarRank(data) {
    fs.writeFileSync(RANK_PATH, JSON.stringify(data, null, 2));
}

function carregarJson(caminho, padrao = {}) {
    if (!fs.existsSync(caminho)) {
        fs.writeFileSync(caminho, JSON.stringify(padrao, null, 2));
        return padrao;
    }
    try {
        return JSON.parse(fs.readFileSync(caminho, 'utf-8'));
    } catch {
        return padrao;
    }
}

function getTextoMensagem(msg) {
    const m = msg.message;
    if (!m) return '';
    if (m.ephemeralMessage?.message) return getTextoMensagem({ message: m.ephemeralMessage.message });
    if (m.viewOnceMessage?.message) return getTextoMensagem({ message: m.viewOnceMessage.message });
    if (m.viewOnceMessageV2?.message) return getTextoMensagem({ message: m.viewOnceMessageV2.message.message || m.viewOnceMessageV2.message });
    if (m.viewOnceMessageV2Extension?.message) return getTextoMensagem({ message: m.viewOnceMessageV2Extension.message });
    if (m.buttonsMessage?.contentText) return m.buttonsMessage.contentText;
    if (m.templateMessage?.hydratedTemplate?.hydratedContentText) return m.templateMessage.hydratedTemplate.hydratedContentText;
    if (m.listMessage?.description) return m.listMessage.description;
    if (m.pollCreationMessage?.name) return m.pollCreationMessage.name;
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    );
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

/**
 * WhatsApp so deixa mandar DM direto pro telefone (@s.whatsapp.net). O id do
 * participante costuma ser o LID, que nao aceita mensagem privada, entao a
 * gente resolve o PN e so tenta o PV se realmente achar um.
 */
async function telefoneParaDM(sock, ref, participants) {
    const p = acharParticipante(participants, ref);
    const cands = [p?.phoneNumber, String(ref || '').includes('@s.whatsapp.net') ? ref : null].filter(Boolean);
    for (const c of cands) {
        if (String(c).endsWith('@s.whatsapp.net')) return c;
    }
    // Ultimo recurso: LID + API de resolucao do proprio socket
    const lid = p?.lid || (String(ref || '').endsWith('@lid') ? ref : null);
    if (lid && typeof sock.signalRepository?.lidMapping?.getPNfromJID === 'function') {
        try {
            const pn = await sock.signalRepository.lidMapping.getPNfromJID(lid);
            if (pn) return `${digitos(pn)}@s.whatsapp.net`;
        } catch { /* sem resolucao */ }
    }
    return null;
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

// ====================== CASSINO ======================
const VERMELHOS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// Ordem real da roda da roleta europeia. A faixa compacta mostra a bola com os
// vizinhos verdadeiros, por isso a sequência inclui o zero entre 26 e 32.
const ORDEM_ROLETA = [
    32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
    5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];
const SEQUENCIA_ROLETA = [0, ...ORDEM_ROLETA];

function rotuloRoleta(numero, destaque = false) {
    if (destaque) return `🔴${numero}`;
    if (numero === 0) return '🤍0';
    return `${VERMELHOS.has(numero) ? '❤️' : '🖤'}${numero}`;
}

function desenharFaixaRoleta(foco) {
    const total = SEQUENCIA_ROLETA.length;
    const i = SEQUENCIA_ROLETA.indexOf(foco);
    if (i < 0) return `🎡 🔴${foco}`;
    const vizinho = (d) => SEQUENCIA_ROLETA[(i + d + total) % total];
    return `🎡 ${rotuloRoleta(vizinho(-1))} ➡️ ${rotuloRoleta(foco, true)} ⬅️ ${rotuloRoleta(vizinho(1))}`;
}

const ESCOLHAS_ROLETA = new Map([
    ['vermelho', 'vermelho'], ['vermelha', 'vermelho'], ['red', 'vermelho'], ['verm', 'vermelho'], ['vm', 'vermelho'], ['v', 'vermelho'],
    ['preto', 'preto'], ['preta', 'preto'], ['black', 'preto'], ['pre', 'preto'], ['pr', 'preto'],
    ['par', 'par'], ['pares', 'par'], ['even', 'par'],
    ['impar', 'impar'], ['impares', 'impar'], ['odd', 'impar'], ['i', 'impar'],
    ['baixo', 'baixo'], ['baixa', 'baixo'], ['baixos', 'baixo'], ['low', 'baixo'], ['b', 'baixo'], ['1-18', 'baixo'], ['1a18', 'baixo'],
    ['alto', 'alto'], ['alta', 'alto'], ['altos', 'alto'], ['high', 'alto'], ['a', 'alto'], ['19-36', 'alto'], ['19a36', 'alto'],
    ['zero', 'numero:0'], ['verde', 'numero:0']
]);

function normalizarEscolhaRoleta(token) {
    const t = normalizar(token);
    if (ESCOLHAS_ROLETA.has(t)) return ESCOLHAS_ROLETA.get(t);
    if (/^\d{1,2}$/.test(t)) {
        const alvo = parseInt(t, 10);
        if (alvo >= 0 && alvo <= 36) return `numero:${alvo}`;
    }
    return null;
}

function interpretarApostaRoleta(args, apostaMinima) {
    const uso = `Uso: ${config.prefixo}rl 10 vermelho\nTambém vale ${config.prefixo}rl vermelho 10. Número direto: ${config.prefixo}rl 10 5.`;
    if (!args.length || args.length > 2) return { erro: uso };
    if (args.length === 1) {
        const escolha = normalizarEscolhaRoleta(args[0]);
        if (!escolha) return { erro: uso };
        return { valor: apostaMinima, escolha };
    }
    const numeros = args.map(a => /^-?\d+$/.test(a) ? parseInt(a, 10) : null);
    const escolhas = args.map(normalizarEscolhaRoleta);
    if (numeros[0] != null && numeros[1] != null) {
        return { valor: numeros[0], escolha: `numero:${numeros[1]}` };
    }
    const iValor = numeros[0] != null ? 0 : numeros[1] != null ? 1 : -1;
    if (iValor < 0 || !escolhas[1 - iValor]) return { erro: uso };
    return { valor: numeros[iValor], escolha: escolhas[1 - iValor] };
}


// Símbolos do tigrinho: [emoji, premio triplo, premio par]
// O pagamento e' separado dos simbolos: primeiro sorteia o TIPO de resultado
// (trinca / par / nada) e so depois o simbolo. Com 3 rolos independentes
// "duas iguais" sai 63% das vezes e qualquer tabela de par paga > 100%, ou
// seja, o jogador lucra sempre e nunca zera. Sorteando o tipo, o RTP fecha
// em ~89% (casa ganha ~11%).
const SIMBOLOS = [
    { e: '🍒', trio: 5, par: 2 },
    { e: '🍋', trio: 8, par: 2 },
    { e: '🍉', trio: 12, par: 2 },
    { e: '🔔', trio: 20, par: 3 },
    { e: '⭐', trio: 35, par: 3 },
    { e: '💎', trio: 80, par: 4 }
];

// ~2,3% trincas, ~28% par exato, resto nao paga
const P_TRINCA = 0.023;
const P_PAR = 0.28;
// trinca e'力士 rara -> quase sempre cereja/limão. Par e' comum -> barato.
const PESO_TRINCA = [55, 20, 10, 7, 4, 4];
const PESO_PAR = [40, 25, 15, 10, 6, 4];

function sortearPonderado(pesos) {
    const total = pesos.reduce((s, x) => s + x, 0);
    let n = Math.random() * total;
    for (let i = 0; i < pesos.length; i++) {
        n -= pesos[i];
        if (n <= 0) return SIMBOLOS[i];
    }
    return SIMBOLOS[0];
}

function simboloDiferente(s) {
    const outros = SIMBOLOS.filter(x => x.e !== s.e);
    return outros[Math.floor(Math.random() * outros.length)];
}

function girarTigrinho() {
    const sorteio = Math.random();
    if (sorteio < P_TRINCA) {
        const t = sortearPonderado(PESO_TRINCA);
        return [t, t, t];
    }
    if (sorteio < P_TRINCA + P_PAR) {
        const p = sortearPonderado(PESO_PAR);
        const outro = simboloDiferente(p);
        const rolo = [p, p, outro];
        // embaralha pra nao sair sempre na mesma posicao
        for (let i = rolo.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rolo[i], rolo[j]] = [rolo[j], rolo[i]];
        }
        return rolo;
    }
    // sem premio: tres simbolos distintos
    const r = [];
    while (r.length < 3) {
        const s = SIMBOLOS[Math.floor(Math.random() * SIMBOLOS.length)];
        if (!r.some(x => x.e === s.e)) r.push(s);
    }
    return r;
}

function saldoDe(dados, jid, user) {
    if (!dados[jid]) dados[jid] = {};
    if (dados[jid][user] === undefined) dados[jid][user] = config.saldoInicial ?? 10;
    return dados[jid][user];
}

function definirSaldo(dados, jid, user, valor) {
    if (!dados[jid]) dados[jid] = {};
    dados[jid][user] = Math.max(0, Math.floor(valor));
    return dados[jid][user];
}

// Zera a carteira. Usado como resposta de "saldo insuficiente".
function avisoSemSaldo(saldo) {
    return `💸 *Você ficou sem fichas!*\n\n` +
        `Saldo atual: *${(saldo || 0).toLocaleString('pt-BR')}*\n\n` +
        `🎁 Espere o bônus diário com \`${config.prefixo}bonus\` ou peça fichas a um ADM.`;
}

// ====================== BLACKJACK ======================
const NAIPES = ['♠️', '♥️', '♦️', '♣️'];
const VALORES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
let BARALHO = [];

function novoBaralho() {
    const b = [];
    for (const naipe of NAIPES)
        for (const valor of VALORES)
            b.push({ naipe, valor });
    for (let i = b.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
}

function embaralharBaralho() {
    BARALHO = novoBaralho();
    return BARALHO;
}

// 21 = blackjack natural. 2 cartas somando 21.
function blackjackNatural(cartas) {
    return cartas.length === 2 && valorDaMao(cartas) === 21;
}

function valorDaCarta(c) {
    if (c.valor === 'A') return 11;
    if (['J', 'Q', 'K'].includes(c.valor)) return 10;
    return parseInt(c.valor, 10);
}

function valorDaMao(cartas) {
    let total = 0, ases = 0;
    for (const c of cartas) {
        total += valorDaCarta(c);
        if (c.valor === 'A') ases++;
    }
    // Ás vale 11, mas se estourar troca pra 1 até caber
    while (total > 21 && ases > 0) {
        total -= 10;
        ases--;
    }
    return total;
}

function cartaTexto(c) {
    return `${c.naipe}${c.valor}`;
}

function maoTexto(cartas) {
    return cartas.map(cartaTexto).join(' ');
}

const jogosBJ = new Map();

function chaveJogo(jid, user) {
    return jid + '|' + user;
}

function comprarCarta() {
    if (BARALHO.length === 0) embaralharBaralho();
    return BARALHO.pop();
}

function iniciarBlackjack(jid, user, aposta) {
    embaralharBaralho();
    const jogo = {
        aposta,
        jogador: [comprarCarta(), comprarCarta()],
        mesa: [comprarCarta(), comprarCarta()],
        turno: 'jogador',
        finished: false
    };
    jogosBJ.set(chaveJogo(jid, user), jogo);
    return jogo;
}

function textoCartaoMesa(jogo, revelar) {
    return revelar ? maoTexto(jogo.mesa) : `${cartaTexto(jogo.mesa[0])} 🂠`;
}

// Dica unica de turno, pra nao repetir texto em 5 lugares diferentes.
function dicaBlackjack() {
    return `\n\n*Pedir mais: \`${config.prefixo}bj 1\`*  •  *Parar: \`${config.prefixo}bj -1\`*`;
}

function textoBlackjack(jid, user, jogo, saldo, revelarMesa) {
    const jv = valorDaMao(jogo.jogador);
    const mv = revealMesa ? valorDaMao(jogo.mesa) : null;
    let out = `🃏 *BLACKJACK*\n\n` +
        `🃏 Você: ${maoTexto(jogo.jogador)} = *${jv}*\n` +
        `🎴 Mesa: ${textoCartaoMesa(jogo, revealMesa)}`;
    if (mv !== null) out += ` = *${mv}*`;
    out += `\n\n💰 Saldo: *${saldo.toLocaleString('pt-BR')}*`;
    return out;
}

function finalizarBlackjack(jid, user, jogo, dados) {
    // resultado: 'venceu' | 'perdeu' | 'empate' | 'estourou' | 'blackjack'
    const jv = valorDaMao(jogo.jogador);
    const mv = valorDaMao(jogo.mesa);
    let titulo, retorno;

    if (resultadoDe(jv, mv, jogo) === 'estourou') {
        titulo = '💥 *ESTOUROU!* Você passou de 21.';
        retorno = 0;
    } else if (resultadoDe(jv, mv, jogo) === 'blackjack') {
        titulo = '🎉 *BLACKJACK!!!* 21 com 2 cartas.';
        retorno = Math.floor(jogo.aposta * 2.5);
    } else if (resultadoDe(jv, mv, jogo) === 'venceu') {
        titulo = '🎉 *GANHOU!* Você fez mais que a mesa.';
        retorno = jogo.aposta * 2;
    } else if (resultadoDe(jv, mv, jogo) === 'empate') {
        titulo = '🤝 *EMPATE!* Mesmo valor.';
        retorno = jogo.aposta;
    } else {
        titulo = '💀 *PERDEU.* A mesa fez mais.';
        retorno = 0;
    }

    const saldo = definirSaldo(dados, jid, user, saldoDe(dados, jid, user) + retorno);
    const lucro = retorno - jogo.aposta;

    let out = textoBlackjack(jid, user, jogo, saldo, true) + '\n\n' + titulo;
    if (lucro > 0) out += `\n💵 *+${lucro.toLocaleString('pt-BR')}* de lucro!`;
    else if (resultadoDe(jv, mv, jogo) === 'empate') out += `\n_(aposta devolvida)_`;
    return { texto: out, saldo, lucro };
}

function resultadoDe(jv, mv, jogo) {
    if (jv > 21) return 'estourou';
    if (blackjackNatural(jogo.jogador)) return 'blackjack';
    // A mesa estourar e' VITORIA do jogador. Precisa vir antes da comparacao,
    // senao 20 vs 25 cai em "perdeu" e a casa ganha ate quando quebra.
    if (mv > 21) return 'venceu';
    if (blackjackNatural(jogo.mesa)) return 'perdeu';
    if (jv > mv) return 'venceu';
    if (jv === mv) return 'empate';
    return 'perdeu';
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
                    const nome = semSufixo(alvoId);
                    const texto = config.mensagemBoasVindas
                        .replace(/{nome}/g, nome)
                        .replace(/{grupo}/g, groupName);
                    await sock.sendMessage(id, { text: texto, mentions: [alvoId] });
                    console.log(` [BOAS-VINDAS] ${alvoId} em ${id}`);
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

    // ================= CASSINO =================
    if (['saldo', 'saldo', 'banca', 'coins', 'moeda'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const dados = carregarJson(CASSINO_PATH);
        const s = saldoDe(dados, jid, sender);
        if (s <= 0) return reply(avisoSemSaldo(s), [sender]);
        return reply(
            `💰 @${semSufixo(sender)} você tem *${s.toLocaleString('pt-BR')}* fichas.\n\n` +
            `🃏 21: \`${config.prefixo}blackjack 1\`\n` +
            `🐯 Tigre: \`${config.prefixo}tigre 1\`\n` +
            `🎰 Roleta: \`${config.prefixo}rl 10 vermelho\``,
            [sender]
        );
    }

    if (['bonus', 'bônus', 'bomus', 'daily'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const dia = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const bonus = carregarJson(BONUS_PATH);
        if (!bonus[jid]) bonus[jid] = {};
        if (bonus[jid][sender] === dia) {
            return reply(`⏳ @${semSufixo(sender)} você já pegou o bônus de hoje. Volta amanhã!`, [sender]);
        }
        bonus[jid][sender] = dia;
        fs.writeFileSync(BONUS_PATH, JSON.stringify(bonus, null, 2));

        const dados = carregarJson(CASSINO_PATH);
        const ganho = config.bonusDiario ?? 2;
        const novo = definirSaldo(dados, jid, sender, saldoDe(dados, jid, sender) + ganho);
        fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));

        return reply(
            `🎁 @${semSufixo(sender)} pegou *+${ganho}* ficha${ganho > 1 ? 's' : ''} de bônus diário!\n💰 Saldo: *${novo.toLocaleString('pt-BR')}*`,
            [sender]
        );
    }

    if (['roleta', 'rol', 'rl', 'rlt', 'roulette', 'giro'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const aposta = interpretarApostaRoleta(args, config.apostaMinima);
        if (aposta.erro) return reply(aposta.erro);
        const { valor, escolha } = aposta;
        if (!valor || valor < config.apostaMinima) {
            return reply(`Aposta mínima: *${config.apostaMinima}* ficha${config.apostaMinima > 1 ? 's' : ''}.\n\nExemplo: ${config.prefixo}rl 10 vermelho`);
        }
        const dados = carregarJson(CASSINO_PATH);
        const saldo = saldoDe(dados, jid, sender);
        if (saldo < valor) return reply(avisoSemSaldo(saldo) + `\n\n_(aposta pedida: ${valor.toLocaleString('pt-BR')})_`);
        definirSaldo(dados, jid, sender, saldo - valor);

        const numero = Math.floor(Math.random() * 37);
        const cor = numero === 0 ? 'verde' : VERMELHOS.has(numero) ? 'vermelho' : 'preto';
        const par = numero !== 0 && numero % 2 === 0;

        let ganhou = false, premio = 0, descricao = '';
        switch (escolha) {
            case 'vermelho':
                ganhou = cor === 'vermelho'; premio = valor * 2; descricao = 'vermelho'; break;
            case 'preto':
                ganhou = cor === 'preto'; premio = valor * 2; descricao = 'preto'; break;
            case 'par':
                ganhou = par; premio = valor * 2; descricao = 'par'; break;
            case 'impar':
                ganhou = numero !== 0 && !par; premio = valor * 2; descricao = 'ímpar'; break;
            case 'baixo':
                ganhou = numero >= 1 && numero <= 18; premio = valor * 2; descricao = '1 a 18'; break;
            case 'alto':
                ganhou = numero >= 19 && numero <= 36; premio = valor * 2; descricao = '19 a 36'; break;
            default: {
                const alvo = parseInt(String(escolha).split(':')[1], 10);
                if (!Number.isInteger(alvo) || alvo < 0 || alvo > 36) {
                    return reply(`❌ Número inválido. Use de *0 a 36* _(o 0 é a casa verde e nunca paga)_.`);
                }
                // O 0 está na roda, mas é a casa verde e sempre perde.
                ganhou = numero === alvo && alvo !== 0;
                premio = valor * 36;
                descricao = alvo === 0 ? 'número 0 (nunca paga)' : `número ${alvo}`;
            }
        }

        let saldoFinal = saldo - valor;
        if (ganhou) { premio = Math.floor(premio); saldoFinal += premio; }
        definirSaldo(dados, jid, sender, saldoFinal);
        fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));

        const bola = cor === 'verde' ? '🟢' : cor === 'vermelho' ? '🔴' : '⚫';
        const saiuZero = numero === 0;
        const cab = ganhou
            ? `🎉 *GANHOU!* +${premio.toLocaleString('pt-BR')} fichas`
            : saiuZero
                ? `🏠 *CASA VERDE!* Você perdeu ${valor.toLocaleString('pt-BR')} fichas`
                : `💀 Perdeu ${valor.toLocaleString('pt-BR')} fichas`;

        // Giro curto na ordem verdadeira: a bola anda e desacelera antes de cair
        // no bolso certo. A faixa mostra só a bola e os vizinhos para a mensagem
        // não quebrar no WhatsApp.
        const dormir = ms => new Promise(r => setTimeout(r, ms));
        const nCasas = SEQUENCIA_ROLETA.length;
        const destino = SEQUENCIA_ROLETA.indexOf(numero);
        const nQuadros = 4 + Math.floor(Math.random() * 2);
        const passos = [];
        let passo = 7, soma = 0;
        for (let i = 0; i < nQuadros; i++) {
            passos.push(passo);
            soma += passo;
            passo = Math.max(1, Math.floor(passo * 0.72));
        }
        if (Math.random() < 0.5) { passos.unshift(nCasas - 1); soma += nCasas - 1; }

        let casa = (destino - soma) % nCasas;
        if (casa < 0) casa += nCasas;
        const trilha = [];
        for (const p of passos) {
            casa = (casa + p) % nCasas;
            trilha.push(casa);
        }
        if (trilha[trilha.length - 1] !== destino) trilha.push(destino);

        for (let i = 0; i < trilha.length; i++) {
            const ultimo = i === trilha.length - 1;
            const bolaDoQuadro = ultimo ? numero : SEQUENCIA_ROLETA[trilha[i]];
            await dormir(trilha.length - i > 2 ? 180 : 360);
            try {
                await sock.sendMessage(jid, {
                    text: `🎰 A bola está girando...\n${desenharFaixaRoleta(bolaDoQuadro)}`
                });
            } catch { /* grupo sem permissao pra enviar: segue sem a animacao */ }
        }

        return reply(
            `🎰 *ROLETA* ${bola} ${numero} ${cor.toUpperCase()}\n` +
            `${desenharFaixaRoleta(numero)}\n` +
            `🎯 Aposta: ${descricao} • ${valor.toLocaleString('pt-BR')}\n` +
            `${cab}\n` +
            `💰 Saldo: *${saldoFinal.toLocaleString('pt-BR')}*`,
            [sender]
        );
    }

    if (['blackjack', 'bj', 'black', 'jogo21', '21'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const acao = (args[0] || '').toLowerCase();
        const chave = chaveJogo(jid, sender);
        const jogo = jogosBJ.get(chave);

        // Continuação de uma partida em andamento
        if (acao === 'hit' || acao === 'pedir' || acao === 'puxar' || acao === 'h' || acao === '1' || acao === '+1' || acao === 'mais') {
            if (!jogo || jogo.finished) return reply('❌ Você não tem jogo em andamento. Use `' + config.prefixo + 'blackjack <aposta>`.');
            const dados = carregarJson(CASSINO_PATH);
            const v = valorDaMao(jogo.jogador);
            if (v === 21) return reply('🃏 Você já fez 21! Use `' + config.prefixo + 'bj -1` para a mesa jogar.');
            jogo.jogador.push(comprarCarta());
            const novoValor = valorDaMao(jogo.jogador);
            if (novoValor > 21) {
                jogo.finished = true;
                jogosBJ.delete(chave);
                const r = finalizarBlackjack(jid, sender, jogo, dados);
                fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
                return reply(r.texto, [sender]);
            }
            if (novoValor === 21) {
                while (valorDaMao(jogo.mesa) < 17) jogo.mesa.push(comprarCarta());
                jogo.turno = 'mesa';
                jogo.finished = true;
                jogosBJ.delete(chave);
                const r = finalizarBlackjack(jid, sender, jogo, dados);
                fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
                return reply(r.texto, [sender]);
            }
            definirSaldo(dados, jid, sender, saldoDe(dados, jid, sender));
            fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
            const saldo = saldoDe(dados, jid, sender);
            return reply(
                textoBlackjack(jid, sender, jogo, saldo, false) + dicaBlackjack(),
                [sender]
            );
        }

        if (acao === 'stand' || acao === 'parar' || acao === 's' || acao === '-1' || acao === 'menos') {
            if (!jogo || jogo.finished) return reply('❌ Você não tem jogo em andamento. Use `' + config.prefixo + 'blackjack <aposta>`.');
            const dados = carregarJson(CASSINO_PATH);
            // A mesa compra até 17 ou mais
            while (valorDaMao(jogo.mesa) < 17) jogo.mesa.push(comprarCarta());
            jogo.finished = true;
            jogosBJ.delete(chave);
            const r = finalizarBlackjack(jid, sender, jogo, dados);
            fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
            return reply(r.texto, [sender]);
        }

        if (acao === 'desistir' || acao === 'sair' || acao === 'd' || acao === '0') {
            if (!jogo || jogo.finished) return reply('❌ Você não tem jogo em andamento.');
            const dados = carregarJson(CASSINO_PATH);
            jogo.finished = true;
            jogosBJ.delete(chave);
            // Desistir devolve metade
            const metade = Math.floor(jogo.aposta / 2);
            const s = definirSaldo(dados, jid, sender, saldoDe(dados, jid, sender) + metade);
            fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
            return reply(
                `🃏 Você desistiu.\n\n` +
                `🎴 Mesa: ${textoCartaoMesa(jogo, true)} = *${valorDaMao(jogo.mesa)}*\n` +
                `Recuperou metade da aposta: *+${metade}*\n` +
                `💰 Saldo: *${s.toLocaleString('pt-BR')}*`,
                [sender]
            );
        }

        // Início de partida
        const valor = parseInt(args[0]);
        if (!valor || valor < config.apostaMinima) {
            return reply(
                `Uso: \`${config.prefixo}blackjack <aposta>\`\n` +
                `Mínimo: ${config.apostaMinima} ficha(s)\n\n` +
                `🃏 21 com 2 cartas paga 2.5x | beating mesa paga 2x | empate devolve`
            );
        }
        const dados = carregarJson(CASSINO_PATH);
        const saldo = saldoDe(dados, jid, sender);
        if (saldo < valor) return reply(avisoSemSaldo(saldo) + `\n\n_(aposta pedida: ${valor.toLocaleString('pt-BR')})_`);
        if (jogo && !jogo.finished) return reply(`⚠️ Você já tem um jogo em andamento! Use \`${config.prefixo}bj -1\` pra parar.`);

        definirSaldo(dados, jid, sender, saldo - valor);
        fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));

        const novoJogo = iniciarBlackjack(jid, sender, valor);

        if (blackjackNatural(novoJogo.jogador)) {
            novoJogo.finished = true;
            jogosBJ.delete(chaveJogo(jid, sender));
            const r = finalizarBlackjack(jid, sender, novoJogo, dados);
            fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
            return reply(r.texto, [sender]);
        }

        return reply(
            textoBlackjack(jid, sender, novoJogo, saldoDe(dados, jid, sender), false) + dicaBlackjack(),
            [sender]
        );
    }

    if (['tigre', 'tigrinho', 'slot', 'tcaça', 'tca'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const valor = parseInt(args[0]);
        if (!valor || valor < config.apostaMinima) {
            return reply(`Uso: ${config.prefixo}tigre <aposta>\nMínimo: ${config.apostaMinima} ficha(s)`);
        }
        const dados = carregarJson(CASSINO_PATH);
        const saldo = saldoDe(dados, jid, sender);
        if (saldo < valor) return reply(avisoSemSaldo(saldo) + `\n\n_(aposta pedida: ${valor.toLocaleString('pt-BR')})_`);
        definirSaldo(dados, jid, sender, saldo - valor);

        const rolo = girarTigrinho();
        const [a, b, c] = rolo;
        let premio = 0, msg = '';
        if (a.e === b.e && b.e === c.e) {
            premio = valor * a.trio;
            msg = `💎 *TRINCA DE ${a.e}*! ${a.trio}x`;
        } else if (a.e === b.e || b.e === c.e || a.e === c.e) {
            const par = a.e === b.e ? a : b.e === c.e ? b : a;
            premio = valor * par.par;
            msg = `✨ *Par de ${par.e}*! ${par.par}x`;
        }
        let saldoFinal = saldo - valor + premio;
        definirSaldo(dados, jid, sender, saldoFinal);

        // Ranking de maiores prêmios do tigrinho (top 10 por grupo)
        let novoRecorde = false;
        if (premio > 0) {
            if (!dados.records) dados.records = {};
            if (!dados.records[jid]) dados.records[jid] = { tigrinho: [] };
            const tab = dados.records[jid].tigrinho;
            const anterior = tab[0]?.premio || 0;
            tab.push({ user: sender, premio, aposta: valor });
            tab.sort((x, y) => y.premio - x.premio);
            dados.records[jid].tigrinho = tab.slice(0, 10);
            novoRecorde = premio > anterior;
        }

        fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));

        // === Giro com parada de carta ===
        // A carta vai parando uma a uma e o multiplicador sobe junto, como
        // caça-níquel de verdade. Começa em 5x (o trio mais barato) e só
        // engata se as cartas baterem entre si.
        const MIN_X = Math.min(...SIMBOLOS.map(s => s.trio));
        const mostrar = (parcial, mult) =>
            `🐯 *TIGRINHO*\n\n` +
            `\`${[0, 1, 2].map(i => parcial[i]?.e || '🎴').join(' │ ')}\`\n` +
            `🎁 Multiplicador: *${mult}x*`;

        const dormir = ms => new Promise(r => setTimeout(r, ms));

        await sock.sendMessage(jid, { text: mostrar([null, null, null], MIN_X) });
        for (let i = 0; i < 3; i++) {
            await dormir(1100);
            const parcial = rolo.slice(0, i + 1);
            const restantes = 3 - parcial.length;
            let mult;
            if (restantes === 0) {
                // última carta: multiplicador definitivo
                if (a.e === b.e && b.e === c.e) mult = a.trio;
                else if (a.e === b.e || b.e === c.e || a.e === c.e) {
                    const p = a.e === b.e ? a : b.e === c.e ? b : a;
                    mult = p.par;
                } else mult = 0;
            } else if (restantes === 1) {
                // duas cartas iguais: jackpot em jogo (o trio daquele símbolo)
                mult = parcial[0].e === parcial[1].e ? parcial[0].trio : MIN_X;
            } else {
                // uma carta: mostra o trio dela, o prêmio que tá em disputa
                mult = parcial[0].trio;
            }
            await sock.sendMessage(jid, { text: mostrar(parcial, mult) });
        }

        const primeiro = novoRecorde;
        return reply(
            `🐯 *TIGRINHO*\n\n` +
            `\`${a.e} │ ${b.e} │ ${c.e}\`\n\n` +
            (premio > 0 ? `🎉 *GANHOU!* +${premio.toLocaleString('pt-BR')}* fichas\n${msg}\n` : `💀 Perdeu ${valor.toLocaleString('pt-BR')}*\n`) +
            (primeiro ? `\n🥇 *NOVO RECORDE DO TIGRINHO!*\n` : '') +
            `💰 Saldo: *${saldoFinal.toLocaleString('pt-BR')}*`,
            [sender]
        );
    }

    if (['convidar', 'recrutar', 'convite'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const precisa = config.convidadosNecessarios ?? 2;
        const porConv = config.fichasPorConvidado ?? 10;
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const marcados = ctx?.mentionedJid || [];

        if (marcados.length < precisa) {
            return reply(
                `🎁 *Recrute para ganhar fichas!*\n\n` +
                `Marque *${precisa} pessoas* e envie:\n` +
                `\`${config.prefixo}convidar @pessoa1 @pessoa2\`\n\n` +
                `Ganhe *${porConv * precisa} fichas* por cada ${precisa} recruitados.`
            );
        }

        const dados = carregarJson(CASSINO_PATH);
        const reg = carregarJson(CONVITES_PATH);
        const validos = [];
        const invalidos = [];

        for (const bruto of marcados.slice(0, precisa)) {
            const u = chaveCanonica(jid, bruto, metadata.participants);
            if (u === sender) { invalidos.push('você mesmo'); continue; }
            if (u === sock.user.id) { invalidos.push('o bot'); continue; }
            if (ehProtegido(sock, u, metadata.participants)) { invalidos.push(`@${semSufixo(u)} (admin/dono)`); continue; }
            if (!acharParticipante(metadata.participants, u)) { invalidos.push(`@${semSufixo(u)} (não está no grupo)`); continue; }
            if (foiConvidado(reg, jid, u)) { invalidos.push(`@${semSufixo(u)} (já foi recruitado)`); continue; }
            if (validos.includes(u)) { invalidos.push(`@${semSufixo(u)} (repetido)`); continue; }
            validos.push(u);
        }

        if (!validos.length) {
            return reply(
                `❌ *Nenhuma pessoa válida pra contar:*\n\n` +
                invalidos.map(x => `• ${x}`).join('\n') +
                `\n\n_convite_: precisa ser alguém *novo* no grupo e que não seja admin.`
            );
        }

        for (const u of validos) marcarConvidado(reg, jid, u, sender);
        fs.writeFileSync(CONVITES_PATH, JSON.stringify(reg, null, 2));

        const ganho = validos.length * porConv;
        const saldo = saldoDe(dados, jid, sender);
        const saldoFinal = definirSaldo(dados, jid, sender, saldo + ganho);
        fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));

        let out = `🎉 *RECRUTAMENTO CONCLUÍDO!*\n\n` +
            validos.map(u => `✅ @${semSufixo(u)}`).join('\n') + '\n\n' +
            `🎁 *+${ganho.toLocaleString('pt-BR')} fichas*\n` +
            `💰 Saldo: *${saldoFinal.toLocaleString('pt-BR')}*`;

        if (invalidos.length) {
            out += `\n\n_ignorados: ${invalidos.map(x => `\`${x}\``).join(', ')}_\n` +
                `_(só valem ${precisa} por comando)_`;
        }

        // Manda o link do grupo no PV de quem recruitou: ai ele repassa pra
        // quem convidou. Sem o link a pessoa nao tem como trazer ninguem.
        const link = await linkDoGrupo(sock, jid);
        if (link) {
            const dm = await telefoneParaDM(sock, sender, metadata.participants);
            if (dm) {
                try {
                    await sock.sendMessage(dm, {
                        text:
                            `🎁 *Você ganhou ${ganho} fichas!*\n\n` +
                            `Repasse esse link para as pessoas que você chamou:\n` +
                            `${link}\n\n` +
                            `_(cada pessoa nova vale ${porConv} fichas, e só conta uma vez)_`
                    });
                    out += `\n\n📬 *Te mandei o link do grupo no PV!*`;
                } catch {
                    out += `\n\n⚠️ *Não consegui mandar no seu PV.* Use este link:\n${link}`;
                }
            } else {
                out += `\n\n📢 *Link do grupo para repassar:*\n${link}`;
            }
        } else {
            out += `\n\n⚠️ *Não consegui pegar o link do grupo.* Me pede como admin que eu libero.`;
        }

        return reply(out, [sender, ...validos]);
    }

    if (['recordes', 'recordes-tigrinho', 'hi-scores'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const dados = carregarJson(CASSINO_PATH);
        const lista = (dados.records?.[jid]?.tigrinho || []).slice(0, 10);
        if (!lista.length) {
            return reply(`🐯 *NINGUÉM BATEU RECORDE AINHOUR*\n\nJogue ${config.prefixo}tigre ${config.apostaMinima} e apareça aqui! 🥇`);
        }
        const medalhas = ['🥇', '🥈', '🥉'];
        let out = `🐯 *MAIORES GANHOS NO TIGRINHO* 🐯\n\n` +
            `🎰 Aposta mínima: ${config.apostaMinima} fichas\n\n`;
        lista.forEach((r, i) => {
            out += `${medalhas[i] || `${i + 1}º`} @${semSufixo(r.user)} — *${r.premio.toLocaleString('pt-BR')}* fichas\n` +
                `   _com aposta de ${r.aposta.toLocaleString('pt-BR')}_\n\n`;
        });
        return reply(out);
    }

    if (['ranking', 'top', 'topcassino'].includes(comando)) {
        if (!config.cassinoAtivo) return reply('🎰 O cassino está fechado no momento.');
        const dados = carregarJson(CASSINO_PATH);
        const lista = Object.entries(dados[jid] || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        if (!lista.length) return reply('🎰 Ninguém jogou ainda. Começa com `!rl 10 vermelho`!');
        const medalhas = ['🥇', '🥈', '🥉'];
        let out = '🏆 *RANKING DO CASSINO*\n\n';
        lista.forEach(([u, v], i) => {
            out += `${medalhas[i] || `${i + 1}.`} @${semSufixo(u)} — *${v.toLocaleString('pt-BR')}*\n`;
        });
        return reply(out);
    }

    if (['dar', 'darficha', 'addficha'].includes(comando)) {
        if (!isAdmin) return reply('❌ Só admins podem dar fichas.');
        const usoDar = `Uso: ${config.prefixo}dar @pessoa 20\nTambém pode responder a mensagem da pessoa com \`${config.prefixo}dar 20\`.`;
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const alvoBruto = ctx?.mentionedJid?.[0] || ctx?.participant || null;
        let alvo = alvoBruto ? chaveCanonica(jid, alvoBruto, metadata.participants) : null;
        if (!alvo && args.length) {
            const textoAlvo = args.find(a => !/[0-9]/.test(a) && !Object.hasOwn(NUMEROS_PT, normalizar(a)));
            const p = textoAlvo ? acharParticipantePorTexto(metadata.participants, textoAlvo) : null;
            if (p) alvo = chaveCanonica(jid, p.id, metadata.participants);
        }
        if (!alvo) return reply(usoDar);
        const valor = extrairInteiro(args);
        if (!valor || valor <= 0) return reply(usoDar);
        const dados = carregarJson(CASSINO_PATH);
        const novo = saldoDe(dados, jid, alvo) + valor;
        definirSaldo(dados, jid, alvo, novo);
        fs.writeFileSync(CASSINO_PATH, JSON.stringify(dados, null, 2));
        return reply(`🎁 @${semSufixo(alvo)} recebeu *${valor.toLocaleString('pt-BR')}* fichas. Saldo: *${novo.toLocaleString('pt-BR')}*`, [alvo]);
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

    if (['cassino', 'casino'].includes(comando)) {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const opt = args[0]?.toLowerCase();

        // !cassino sem argumento alterna; on/off fixa o estado. Qualquer outra
        // palavra e' erro de digitacao e nao pode acabar virando um toggle.
        if (opt == null) {
            config.cassinoAtivo = !config.cassinoAtivo;
        } else if (opt === 'on') {
            config.cassinoAtivo = true;
        } else if (opt === 'off') {
            config.cassinoAtivo = false;
        } else {
            return reply(
                `❌ Opção inválida: *${opt}*\n\n` +
                `\`${config.prefixo}cassino\` - Abre ou fecha\n` +
                `\`${config.prefixo}cassino on\` - Abre\n` +
                `\`${config.prefixo}cassino off\` - Fecha`
            );
        }
        salvarConfig();

        return reply(
            config.cassinoAtivo
                ? `🎰 *CASSINO ABERTO!* 🎉\n\n` +
                  `O cassino está liberado! Todo mundo pode jogar:\n` +
                  `• 🐯 tigrinho, 🃏 blackjack, 🎡 roleta\n` +
                  `• 💵 fichas e 🎁 bônus diário\n\n` +
                  `📋 \`${config.prefixo}jogos\` - Ver os jogos\n` +
                  `🔒 \`${config.prefixo}cassino\` - Fechar o cassino`
                : `🔒 *CASSINO FECHADO!*\n\n` +
                  `Ninguém consegue mais apostar por enquanto.\n` +
                  `As fichas de cada um estão guardadas. 💰\n\n` +
                  `🔓 \`${config.prefixo}cassino\` - Abrir o cassino`
        );
    }

    if (['jogos', 'jogatina', 'apostas'].includes(comando)) {
        return reply(
            `*🎰 CASSINO* 🎰\n\n` +
            `*💰 Carteira*\n` +
            `💵 \`${config.prefixo}saldo\` - Vê suas fichas\n` +
            `🎁 \`${config.prefixo}bonus\` - Bônus diário (+${config.bonusDiario})\n` +
            `🤝 \`${config.prefixo}convidar @a @b\` - Traga ${config.convidadosNecessarios} novos (+${config.fichasPorConvidado} cada)\n` +
            `\n` +
            `*🕹️ Jogos*\n` +
            `🐯 \`${config.prefixo}tigre <aposta>\` - Caça-níquel\n` +
            `🃏 \`${config.prefixo}blackjack <aposta>\` - 21 contra a mesa\n` +
            `   ↳ \`${config.prefixo}bj 1\` pede mais | \`${config.prefixo}bj -1\` parar\n` +
            `🎡 \`${config.prefixo}rl 10 vermelho\` - Roleta simples\n` +
            `\n` +
            `*🏆 Ranking*\n` +
            `🏅 \`${config.prefixo}recordes\` - Maiores prêmios do tigrinho\n` +
            `📊 \`${config.prefixo}ranking\` - Ranking de saldo\n` +
            (isAdmin
                ? `\n*🎁 ADMs*\n🎁 \`${config.prefixo}dar @usuario <valor>\` - Dá fichas\n` +
                  `🔒 \`${config.prefixo}cassino\` - Abre/fecha o cassino\n`
                : '')
        );
    }

    if (comando === 'ping') {
        return reply('🏓 Pong! Bot online.');
    }

    if (comando === 'status') {
        return reply(
            `🩺 Status do bot\n` +
            `Palavras: ${config.palavrasProibidas.length} | Antilink: ${config.antilink ? 'ON' : 'OFF'}\n` +
            `Cassino: ${config.cassinoAtivo ? 'ABERTO' : 'FECHADO'}\n` +
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
            `🔒 \`${config.prefixo}cassino\` - Abre/fecha o cassino\n` +
            `🔒 \`${config.prefixo}fechar\` - Fecha o grupo (só ADMs falam)\n` +
            `🔓 \`${config.prefixo}abrir\` - Abre o grupo\n` +
            `⏰ Auto: abre 5h e fecha 0h (Angola)\n` +
            `\n` +
            `🎰 *CASSINO* 🎰\n` +
            `🎰 \`${config.prefixo}jogos\` - Ver jogos e fichas\n` +
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
            `🎰 *CASSINO* 🎰\n` +
            `🎰 \`${config.prefixo}jogos\` - Ver jogos e fichas\n` +
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
