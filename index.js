require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const imghash = require('imghash');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');

// --- 1. DATABASE MODELS ---
const itemSchema = new mongoose.Schema({
    name: String,
    hash: { type: String, index: true },
    file_ids: { type: [String], index: true },
    file_unique_ids: { type: [String], index: true },
    addedBy: String,
    createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    isSudo: { type: Boolean, default: false },
    canPromote: { type: Boolean, default: false }
});

const commandSchema = new mongoose.Schema({
    userId: { type: String, index: true },
    cmd: String
});

const Item = mongoose.model('Item', itemSchema);
const User = mongoose.model('Sudouser', userSchema);
const Command = mongoose.model('Command', commandSchema);

// --- 2. MIDDLEWARE & UTILITIES ---
async function checkSudo(ctx, next) {
    const userId = ctx.from.id.toString();
    if (userId === process.env.SUDO_ID) return next();
    const user = await User.findOne({ userId, isSudo: true });
    if (user) return next();
    return ctx.reply("⛔ Access Denied: Sudo only.");
}

function getHammingDistance(h1, h2) {
    if (!h1 || !h2 || h1.length !== h2.length) return 100;
    let dist = 0;
    for (let i = 0; i < h1.length; i++) {
        if (h1[i] !== h2[i]) dist++;
    }
    return dist;
}

async function getHashFromUrl(url) {
    try {
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        return await imghash.hash(buffer, 16);
    } catch (e) {
        console.error("Hashing failed:", e.message);
        return null;
    }
}

// --- 3. DATABASE CONNECTION ---
mongoose.connect(process.env.Mongodb_url).then(async () => {
    console.log("✅ MongoDB Connected");
    await User.findOneAndUpdate(
        { userId: process.env.SUDO_ID },
        { isSudo: true, canPromote: true },
        { upsert: true }
    );
});

const bot = new Telegraf(process.env.myWaifusBot);

// --- 4. START COMMAND WITH BUTTONS ---
bot.start(async (ctx) => {
    try {
        let welcomeMsg = "🌸 Waifu Bot မှ ကြိုဆိုပါတယ် ✨";
        if (fs.existsSync('Welcome.txt')) {
            welcomeMsg = fs.readFileSync('Welcome.txt', 'utf8');
        }

        await ctx.reply(welcomeMsg, Markup.inlineKeyboard([
            [Markup.button.callback('🌟 Main Feature', 'main_feat')], // Row 1: Single Button
            [
                Markup.button.url('📢 Channel', 'https://t.me/MinSaiZayYar'), 
                Markup.button.callback('🔍 Search Help', 'help_search')
            ], // Row 2: Two Buttons
            [
                Markup.button.url('👤 Support', 'https://t.me/MinSaiZayYar'), 
                Markup.button.callback('📊 Stats', 'view_stats')
            ]  // Row 3: Two Buttons
        ]));
    } catch (err) {
        console.error(err);
    }
});

// --- 5. SEARCH LOGIC ---
const handleSearch = async (ctx) => {
    if (ctx.message.media_group_id) return;
    const msg = (ctx.message.reply_to_message && (ctx.message.reply_to_message.photo || ctx.message.reply_to_message.video)) 
                ? ctx.message.reply_to_message : ctx.message;
    if (!msg.photo && !msg.video) return;

    try {
        let uId, thumbId;
        if (msg.photo) {
            uId = msg.photo[msg.photo.length - 1].file_unique_id;
            thumbId = msg.photo[msg.photo.length - 1].file_id;
        } else {
            uId = msg.video.file_unique_id;
            thumbId = msg.video.thumb?.file_id || msg.video.file_id;
        }

        const targetId = msg.forward_from?.id.toString() || ctx.message.reply_to_message?.from.id.toString() || ctx.from.id.toString();
        const tagData = await Command.findOne({ userId: targetId });
        const userTag = tagData ? `${tagData.cmd} ` : "";

        // Fast Match
        const fast = await Item.findOne({ file_unique_ids: uId });
        if (fast) {
            return ctx.reply(`⚡ Instant Match: \`${userTag}${fast.name}\``, { parse_mode: 'MarkdownV2', reply_to_message_id: msg.message_id });
        }

        // Visual Match
        ctx.sendChatAction('typing');
        const link = await ctx.telegram.getFileLink(thumbId);
        const userHash = await getHashFromUrl(link.href);
        if (!userHash) return;

        const all = await Item.find({ hash: { $exists: true, $ne: null } }, 'hash name');
        let match = null;
        let bestDist = 10;

        for (const item of all) {
            const d = getHammingDistance(userHash, item.hash);
            if (d < bestDist) {
                bestDist = d;
                match = item;
                if (d === 0) break;
            }
        }

        if (match) {
            await Item.updateOne({ _id: match._id }, { $addToSet: { file_unique_ids: uId } });
            ctx.reply(`🔍 Visual Match: \`${userTag}${match.name}\``, { parse_mode: 'MarkdownV2', reply_to_message_id: msg.message_id });
        }
    } catch (e) {
        console.error("Search Error:", e.message);
    }
};

// --- 6. ADMIN COMMANDS ---
bot.command('addWa', checkSudo, async (ctx) => {
    const reply = ctx.message.reply_to_message;
    const name = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!reply || (!reply.photo && !reply.video) || !name) {
        return ctx.reply("Usage: Reply to media with `/addWa {name}`");
    }
    try {
        let fId, uId, thumbId;
        if (reply.photo) {
            const p = reply.photo[reply.photo.length - 1];
            fId = p.file_id; uId = p.file_unique_id; thumbId = fId;
        } else {
            fId = reply.video.file_id; uId = reply.video.file_unique_id; thumbId = reply.video.thumb?.file_id || fId;
        }
        const link = await ctx.telegram.getFileLink(thumbId);
        const hash = await getHashFromUrl(link.href);
        const exists = await Item.findOne({ $or: [{ hash }, { file_unique_ids: uId }] });
        if (exists) return ctx.reply(`⚠️ Already exists: **${exists.name}**`, { parse_mode: 'Markdown' });
        
        await Item.create({ name, hash, file_ids: [fId], file_unique_ids: [uId], addedBy: ctx.from.id.toString() });
        ctx.reply(`✅ Added: **${name}**`, { parse_mode: 'Markdown' });
    } catch (e) { ctx.reply("❌ Error adding."); }
});

bot.command('delWa', checkSudo, async (ctx) => {
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply("Reply to media to delete.");
    const uId = reply.photo ? reply.photo[reply.photo.length - 1].file_unique_id : reply.video?.file_unique_id;
    const result = await Item.findOneAndDelete({ file_unique_ids: uId });
    result ? ctx.reply(`🗑️ Deleted: **${result.name}**`) : ctx.reply("❌ Not found.");
});

// --- 7. BUTTON CALLBACKS ---
bot.action('help_search', (ctx) => ctx.answerCbQuery("ပုံပို့ပြီး ရှာနိုင်ပါတယ်!", { show_alert: true }));
bot.action('view_stats', async (ctx) => {
    const count = await Item.countDocuments();
    ctx.answerCbQuery(`စုစုပေါင်း Waifu ${count} ခု ရှိပါတယ်`, { show_alert: true });
});
bot.action('main_feat', (ctx) => ctx.answerCbQuery("This is the main button feature!"));

// --- 8. INITIALIZE ---
bot.command(['wa', 'waifu'], handleSearch);
bot.on(['photo', 'video'], handleSearch);

bot.launch().then(() => console.log("🚀 Bot is running..."));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
