import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import pino from 'pino';

const CONFIG_PATH = './config.json';
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const NOME_BOT_FANCY = '𝐟𝐚𝐦𝐢𝐥𝐢𝐚-𝟏𝟓𝟕-𝐛𝐨𝐭';

const mensagensBot = {};

const WARNINGS_PATH = './warnings.json';
const RANK_PATH = './rank.json';
const AUTH_FOLDER = './auth_info';

// --- Persistência de advertências ---
function carregarWarnings() {
    if (!fs.existsSync(WARNINGS_PATH)) {
        fs.writeFileSync(WARNINGS_PATH, JSON.stringify({}, null, 2));
        return {};
    }
    return JSON.parse(fs.readFileSync(WARNINGS_PATH, 'utf-8'));
}

function salvarWarnings(data) {
    fs.writeFileSync(WARNINGS_PATH, JSON.stringify(data, null, 2));
}

// --- Persistência de ranking ---
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

function getTextoMensagem(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ''
    );
}

// --- Identidade anti-LID: prefere o número de telefone (PN) ---
function getSender(msg, jid) {
    return msg.key.senderPn || msg.key.participant || msg.participant || jid;
}

function ehAdmin(participants, jid) {
    const p = participants.find(x => x.id === jid || x.phoneNumber === jid || x.lid === jid);
    return p?.admin === 'admin' || p?.admin === 'superadmin';
}

function contemConteudoProibido(texto) {
    if (!texto) return { proibido: false };

    const textoLower = texto.toLowerCase();

    // Verifica links se antilink ativo
    if (config.antilink) {
        for (const pattern of config.linkRegex) {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(texto)) {
                return { proibido: true, motivo: 'link' };
            }
        }
    }

    // Verifica palavras proibidas
    for (const palavra of config.palavrasProibidas) {
        if (textoLower.includes(palavra.toLowerCase())) {
            return { proibido: true, motivo: `palavra: ${palavra}` };
        }
    }

    return { proibido: false };
}

async function iniciarBot() {
    // --- Restaura sessão via variável de ambiente (hospedagem) ---
    if (process.env.AUTH_B64) {
        try {
            if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
            const credsJson = Buffer.from(process.env.AUTH_B64, 'base64').toString('utf-8');
            JSON.parse(credsJson); // valida
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
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // --- Pareamento por código: pede quando a conexão já está aberta (evento qr) ---
    const numeroPareamento = String(process.env.NUMERO_BOT || config.numeroBot || '').replace(/\D/g, '');
    let pareamentoSolicitado = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Se tem número configurado e NENHUMA identidade ainda, usa código de pareamento (conexão já aberta aqui)
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
            console.log(`\n Bot "${config.nomeBot}" conectado com sucesso!`);
            console.log(` Prefixo: ${config.prefixo} | Max advertências: ${config.maxAdvertencias}`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errMsg = lastDisconnect?.error?.message;
            console.log(` Conexão fechada. status=${statusCode} erro=${errMsg}`);
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(' Reconectando:', shouldReconnect);
            if (shouldReconnect) iniciarBot();
        }
    });

    // --- Boas-vindas com foto de perfil ---
    sock.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            if (action !== 'add') return;

            const metadata = await sock.groupMetadata(id);
            const groupName = metadata.subject;

            for (const participant of participants) {
                const nome = participant.split('@')[0];

                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(participant, 'image');
                } catch { ppUrl = null; }

                const texto =
                    `*🎉 BEM-VINDO(A) À FAMÍLIA!* 🎉\n` +
                    `\n` +
                    `𝐅𝐀𝐌𝐈𝐋𝐈𝐀 𝟏𝟕𝟏🃏\n` +
                    `\n` +
                    `👋 @${nome} entrou no grupo *${groupName}*\n` +
                    `\n` +
                    `📖 Leia a descrição e se divirta! ❤️`;

                if (ppUrl) {
                    await sock.sendMessage(id, {
                        image: { url: ppUrl },
                        caption: texto,
                        mentions: [participant]
                    });
                } else {
                    await sock.sendMessage(id, {
                        text: texto,
                        mentions: [participant]
                    });
                }
                console.log(` [BOAS-VINDAS] ${participant} em ${id}`);
            }
        } catch (e) {
            console.log('Erro no boas-vindas:', e.message);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                // Guarda as mensagens enviadas pelo bot pra poder limpar depois
                if (msg.key.fromMe && msg.key.remoteJid) {
                    const jidBot = msg.key.remoteJid;
                    if (!mensagensBot[jidBot]) mensagensBot[jidBot] = [];
                    mensagensBot[jidBot].push(msg.key);
                    if (mensagensBot[jidBot].length > 60) mensagensBot[jidBot].shift();
                    continue;
                }

                if (!msg.message) continue;

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                if (!isGroup) continue; // só atua em grupos

                // Filtro de grupos permitidos (se configurado)
                if (config.gruposPermitidos.length > 0 && !config.gruposPermitidos.includes(jid)) continue;

                const texto = getTextoMensagem(msg);
                if (!texto) continue;

                const sender = getSender(msg, jid);

                // --- Comandos ---
                if (texto.startsWith(config.prefixo)) {
                    await handleComandos(sock, msg, jid, texto, sender);
                    continue;
                }

                // Ignora admins se configurado
                if (config.ignorarAdmins) {
                    const metadata = await sock.groupMetadata(jid);
                    const isAdmin = ehAdmin(metadata.participants, sender);
                    if (isAdmin) continue;
                }

                // --- Verificação de conteúdo proibido ---
                const check = contemConteudoProibido(texto);
                if (!check.proibido) continue;

                console.log(` [DETECTADO] ${sender} -> "${texto}" | motivo: ${check.motivo}`);

                // 1. Apaga a mensagem
                try {
                    await sock.sendMessage(jid, { delete: msg.key });
                    console.log('  -> Mensagem apagada');
                } catch (e) {
                    console.log('  -> Erro ao apagar (bot precisa ser admin):', e.message);
                    continue;
                }

                // 2. Sistema de advertências
                const warnings = carregarWarnings();
                if (!warnings[jid]) warnings[jid] = {};
                if (!warnings[jid][sender]) warnings[jid][sender] = 0;
                warnings[jid][sender] += 1;
                const atual = warnings[jid][sender];
                salvarWarnings(warnings);

                // 3. Envia aviso marcando o usuário (igual ao print)
                let textoAdvertencia = config.mensagemAdvertencia
                    .replace('{atual}', atual)
                    .replace('{max}', config.maxAdvertencias);

                // Aviso extra no 2/3
                if (atual === config.maxAdvertencias - 1) {
                    textoAdvertencia += `\n\n⚠️ *NA PRÓXIMA VAI LEVAR BAN!*`;
                }

                // Mensagem no estilo do print: ⛔ @usuario links não permitidos! Advertência 2/3
                await sock.sendMessage(jid, {
                    text: `⛔ @${sender.split('@')[0]} ${textoAdvertencia}`,
                    mentions: [sender]
                });

                // 4. Aplica punição se atingiu o máximo
                if (atual >= config.maxAdvertencias) {
                    if (config.acaoAposMax === 'remover') {
                        await new Promise(r => setTimeout(r, 1000));
                        try {
                            await sock.groupParticipantsUpdate(jid, [sender], 'remove');
                            await sock.sendMessage(jid, {
                                text: `🚫 @${sender.split('@')[0]} removido após ${config.maxAdvertencias} advertências.`,
                                mentions: [sender]
                            });
                            console.log(`  -> Usuário ${sender} removido`);
                        } catch (e) {
                            console.log('  -> Erro ao remover usuário (bot precisa ser admin):', e.message);
                        }
                    }
                    // Zera após punição
                    warnings[jid][sender] = 0;
                    salvarWarnings(warnings);
                }

            } catch (err) {
                console.error('Erro ao processar mensagem:', err);
            }
        }
    });
}

async function handleComandos(sock, msg, jid, texto, sender) {
    const args = texto.slice(config.prefixo.length).trim().split(/ +/);
    const comando = args.shift().toLowerCase();
    const metadata = await sock.groupMetadata(jid);
    const isAdmin = ehAdmin(metadata.participants, sender);
    const botId = sock.user.id;
    const botP = metadata.participants.find(p => p.id === botId || p.phoneNumber === botId || p.lid === botId);
    const isBotAdmin = botP?.admin;

    // helper pra responder
    const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });

    if (comando === 'addpalavra' || comando === 'addword') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const palavra = args.join(' ').toLowerCase();
        if (!palavra) return reply(`Uso: ${config.prefixo}addpalavra <palavra>`);
        if (config.palavrasProibidas.includes(palavra)) return reply('⚠️ Essa palavra já está na lista.');
        config.palavrasProibidas.push(palavra);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return reply(`✅ Palavra "${palavra}" adicionada.`);
    }

    if (comando === 'rmpalavra' || comando === 'removepalavra') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const palavra = args.join(' ').toLowerCase();
        const idx = config.palavrasProibidas.indexOf(palavra);
        if (idx === -1) return reply('⚠️ Palavra não encontrada.');
        config.palavrasProibidas.splice(idx, 1);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return reply(`✅ Palavra "${palavra}" removida.`);
    }

    if (comando === 'listapalavras' || comando === 'listwords') {
        return reply(`📋 Palavras proibidas:\n${config.palavrasProibidas.join(', ') || '(nenhuma)'}\n\nAntilink: ${config.antilink ? 'ON' : 'OFF'}`);
    }

    if (comando === 'antilink') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const opt = args[0]?.toLowerCase();
        if (opt === 'on') config.antilink = true;
        else if (opt === 'off') config.antilink = false;
        else return reply(`Uso: ${config.prefixo}antilink on/off (atual: ${config.antilink ? 'ON' : 'OFF'})`);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return reply(`✅ Antilink: ${config.antilink ? 'ATIVADO' : 'DESATIVADO'}`);
    }

    if (comando === 'advertencias' || comando === 'warns') {
        const warnings = carregarWarnings();
        const alvo = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
        const qtd = warnings[jid]?.[alvo] || 0;
        return reply(`⚠️ @${alvo.split('@')[0]} tem ${qtd}/${config.maxAdvertencias} advertências.`, { mentions: [alvo] });
    }

    if (comando === 'zerar' || comando === 'resetwarn') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const ctxZerar = msg.message?.extendedTextMessage?.contextInfo;
        const alvo = ctxZerar?.mentionedJid?.[0] || ctxZerar?.participant;
        if (!alvo) return reply(`Uso: ${config.prefixo}zerar @usuario ou responda a mensagem dele com ${config.prefixo}zerar`);
        const warnings = carregarWarnings();
        if (warnings[jid]) warnings[jid][alvo] = 0;
        salvarWarnings(warnings);
        return sock.sendMessage(jid, { text: `✅ Advertências de @${alvo.split('@')[0]} zeradas.`, mentions: [alvo] });
    }

    if (comando === 'ban') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const alvo = ctx?.mentionedJid?.[0] || ctx?.participant;
        if (!alvo) return reply(`Uso: ${config.prefixo}ban @usuario ou responda a mensagem dele com ${config.prefixo}ban`);
        if (alvo === sender) return reply('❌ Você não pode se banir kkk');
        if (alvo === sock.user.id) return reply('❌ Não vou me banir kkk');
        try {
            await sock.groupParticipantsUpdate(jid, [alvo], 'remove');
            return sock.sendMessage(jid, {
                text: `🚫 @${alvo.split('@')[0]} foi banido do grupo.`,
                mentions: [alvo]
            });
        } catch (e) {
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
            } catch {}
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

    if (comando === 'ping') {
        return reply('🏓 Pong! Bot online.');
    }

    if (comando === 'ajuda' || comando === 'help' || comando === 'menu') {
        const menu =
            `*🤖 ${NOME_BOT_FANCY} - Menu de Comandos* 🤖\n` +
            `\n` +
            `🛡️ *MODERAÇÃO (só ADMs)* 🛡️\n` +
            `➕ \`${config.prefixo}addpalavra <palavra>\` - Adiciona palavra proibida\n` +
            `➖ \`${config.prefixo}rmpalavra <palavra>\` - Remove palavra proibida\n` +
            `📋 \`${config.prefixo}listapalavras\` - Lista palavras bloqueadas\n` +
            `🔗 \`${config.prefixo}antilink on/off\` - Liga/desliga anti-link\n` +
            `♻️ \`${config.prefixo}zerar @usuario\` - Zera advertências\n` +
            `🚫 \`${config.prefixo}ban\` - Bane (marca ou responde a msg)\n` +
            `🗑️ \`${config.prefixo}limpar\` - Apaga mensagens do bot\n` +
            `⚠️ \`${config.prefixo}advertencias\` - Vê advertências\n` +
            `\n` +
            `📡 *GERAL* 📡\n` +
            `🖼️ \`${config.prefixo}s\` - Cria figurinha\n` +
            `🏓 \`${config.prefixo}ping\` - Testa se o bot está online\n` +
            `❓ \`${config.prefixo}ajuda\` - Mostra este menu`;

        if (isAdmin) {
            return reply(menu);
        } else {
            return reply(
                `*🤖 ${NOME_BOT_FANCY} - Menu de Comandos* 🤖\n` +
                `\n` +
                `👥 *MEMBROS* 👥\n` +
                `📋 \`${config.prefixo}listapalavras\` - Lista palavras bloqueadas\n` +
                `⚠️ \`${config.prefixo}advertencias\` - Vê advertências\n` +
                `\n` +
                `📡 *GERAL* 📡\n` +
                `🖼️ \`${config.prefixo}s\` - Cria figurinha\n` +
                `🏓 \`${config.prefixo}ping\` - Testa se o bot está online\n` +
                `❓ \`${config.prefixo}ajuda\` - Mostra este menu`
            );
        }
    }
}

iniciarBot();
