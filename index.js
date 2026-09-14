const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const pino = require('pino');

const CONFIG_PATH = './config.json';
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

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
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n Escaneie o QR Code abaixo com o WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log(`\n Bot "${config.nomeBot}" conectado com sucesso!`);
            console.log(` Prefixo: ${config.prefixo} | Max advertências: ${config.maxAdvertencias}`);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(' Conexão fechada. Reconectando:', shouldReconnect);
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
                const texto = `Seja bem vindo(a) a familia TKG-❤️\n\n@${nome} entrou em *${groupName}*`;
                await sock.sendMessage(id, {
                    text: texto,
                    mentions: [participant]
                });
                console.log(` [BOAS-VINDAS] ${participant} em ${id}`);
            }
        } catch (e) {
            console.log('Erro no boas-vindas:', e.message);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                if (!isGroup) continue; // só atua em grupos

                // Filtro de grupos permitidos (se configurado)
                if (config.gruposPermitidos.length > 0 && !config.gruposPermitidos.includes(jid)) continue;

                const texto = getTextoMensagem(msg);
                if (!texto) continue;

                const sender = msg.key.participant || msg.participant || jid;

                // --- Comandos ---
                if (texto.startsWith(config.prefixo)) {
                    await handleComandos(sock, msg, jid, texto, sender);
                    continue;
                }

                // Ignora admins se configurado
                if (config.ignorarAdmins) {
                    const metadata = await sock.groupMetadata(jid);
                    const senderAdmin = metadata.participants.find(p => p.id === sender);
                    const isAdmin = senderAdmin?.admin === 'admin' || senderAdmin?.admin === 'superadmin';
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
    const senderData = metadata.participants.find(p => p.id === sender);
    const isAdmin = senderData?.admin === 'admin' || senderData?.admin === 'superadmin';
    const isBotAdmin = metadata.participants.find(p => p.id === sock.user.id)?.admin;

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
        const alvo = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!alvo) return reply(`Uso: ${config.prefixo}zerar @usuario`);
        const warnings = carregarWarnings();
        if (warnings[jid]) warnings[jid][alvo] = 0;
        salvarWarnings(warnings);
        return sock.sendMessage(jid, { text: `✅ Advertências de @${alvo.split('@')[0]} zeradas.`, mentions: [alvo] });
    }

    if (comando === 'ban') {
        if (!isAdmin) return reply('❌ Só admins podem usar este comando.');
        const alvo = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        if (!alvo) return reply(`Uso: ${config.prefixo}ban @usuario`);
        if (alvo === sender) return reply('❌ Você não pode se banir kkk');
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

    if (comando === 'ping') {
        return reply('🏓 Pong! Bot online.');
    }

    if (comando === 'ajuda' || comando === 'help' || comando === 'menu') {
        const menu =
            `*🤖 ${config.nomeBot} - Menu de Comandos* 🤖\n` +
            `\n` +
            `🛡️ *MODERAÇÃO (só ADMs)* 🛡️\n` +
            `➕ \`${config.prefixo}addpalavra <palavra>\` - Adiciona palavra proibida\n` +
            `➖ \`${config.prefixo}rmpalavra <palavra>\` - Remove palavra proibida\n` +
            `📋 \`${config.prefixo}listapalavras\` - Lista palavras bloqueadas\n` +
            `🔗 \`${config.prefixo}antilink on/off\` - Liga/desliga anti-link\n` +
            `♻️ \`${config.prefixo}zerar @usuario\` - Zera advertências\n` +
            `🚫 \`${config.prefixo}ban @usuario\` - Bane do grupo\n` +
            `⚠️ \`${config.prefixo}advertencias\` - Vê advertências\n` +
            `\n` +
            `📡 *GERAL* 📡\n` +
            `🏓 \`${config.prefixo}ping\` - Testa se o bot está online\n` +
            `❓ \`${config.prefixo}ajuda\` - Mostra este menu`;

        if (isAdmin) {
            return reply(menu);
        } else {
            return reply(
                `*🤖 ${config.nomeBot} - Menu de Comandos* 🤖\n` +
                `\n` +
                `👥 *MEMBROS* 👥\n` +
                `📋 \`${config.prefixo}listapalavras\` - Lista palavras bloqueadas\n` +
                `⚠️ \`${config.prefixo}advertencias\` - Vê advertências\n` +
                `\n` +
                `📡 *GERAL* 📡\n` +
                `🏓 \`${config.prefixo}ping\` - Testa se o bot está online\n` +
                `❓ \`${config.prefixo}ajuda\` - Mostra este menu`
            );
        }
    }
}

iniciarBot();
