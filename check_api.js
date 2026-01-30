const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置区 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const README_PATH = path.join(__dirname, "README.md");

const MAX_DAYS = 30;
const WARN_STREAK = 3; 
const ENABLE_SEARCH_TEST = true;
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 10; 
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 500;

// === 1. 加载配置 (适配数组格式) ===
if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在:", CONFIG_PATH);
    process.exit(1);
}
const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const apiEntries = configArray.map((s) => ({
    name: s.name,
    api: s.baseUrl,
    id: s.id || "-",
    disabled: s.enabled === false,
}));

// === 2. 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
    const old = fs.readFileSync(REPORT_PATH, "utf-8");
    const match = old.match(/```json\n([\s\S]+?)\n```/);
    if (match) { try { history = JSON.parse(match[1]); } catch (e) {} }
}

const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";

// === 3. 工具函数 ===
const delay = ms => new Promise(r => setTimeout(r, ms));

const safeGet = async (url) => {
    for (let i = 1; i <= MAX_RETRY; i++) {
        try {
            const res = await axios.get(url, { timeout: TIMEOUT_MS });
            return res.status === 200;
        } catch (e) { if (i < MAX_RETRY) await delay(RETRY_DELAY_MS); }
    }
    return false;
};

const testSearch = async (api, keyword) => {
    for (let i = 1; i <= MAX_RETRY; i++) {
        try {
            const url = `${api}?wd=${encodeURIComponent(keyword)}`;
            const res = await axios.get(url, { timeout: TIMEOUT_MS });
            if (res.status !== 200 || !res.data || !res.data.list) return "❌";
            return res.data.list.length ? "✅" : "无结果";
        } catch (e) { if (i < MAX_RETRY) await delay(RETRY_DELAY_MS); }
    }
    return "❌";
};

const queueRun = async (tasks, limit) => {
    const results = [];
    const executing = new Set();
    for (const [i, task] of tasks.entries()) {
        const p = task().then(res => results[i] = res);
        executing.add(p);
        p.finally(() => executing.delete(p));
        if (executing.size >= limit) await Promise.race(executing);
    }
    await Promise.all(executing);
    return results;
};

// === 4. 主逻辑 ===
(async () => {
    console.log(`⏳ 开始检测 ${apiEntries.length} 个接口...`);

    const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
        if (disabled) return { api, success: false, searchStatus: "禁用" };
        const ok = await safeGet(api);
        const searchStatus = (ok && ENABLE_SEARCH_TEST) ? await testSearch(api, SEARCH_KEYWORD) : "-";
        return { api, success: ok, searchStatus };
    });

    const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);
    history.push({ date: new Date().toISOString().slice(0, 10), results: todayResults });
    if (history.length > MAX_DAYS) history.shift();

    // 统计与排版
    const stats = apiEntries.map(s => {
        const latest = todayResults.find(r => r.api === s.api);
        let streak = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            const r = history[i].results.find(x => x.api === s.api);
            if (r && r.success) break;
            streak++;
        }
        
        let status = "✅";
        if (s.disabled) status = "🚫";
        else if (streak >= WARN_STREAK) status = "🚨";
        else if (!latest?.success) status = "❌";

        return { ...s, status, streak, searchStatus: latest?.searchStatus || "❌" };
    }).sort((a, b) => {
        const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
        return order[a.status] - order[b.status];
    });

    // 生成表格
    let table = "| 状态 | 名称 | ID | 接口 | 搜索 | 连跪 |\n|---|---|---|---|---|---|\n";
    stats.forEach(s => {
        table += `| ${s.status} | ${s.name} | ${s.id} | [Link](${s.api}) | ${s.searchStatus} | ${s.streak} |\n`;
    });

    const reportMd = `# 接口检测报告\n\n更新时间: ${nowCST}\n\n${table}\n\n<details><summary>历史数据</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>`;

    // 写入 report.md
    fs.writeFileSync(REPORT_PATH, reportMd);

    // 写入 README.md (如果有标记)
    if (fs.existsSync(README_PATH)) {
        let readme = fs.readFileSync(README_PATH, "utf-8");
        const startTag = "";
        const endTag = "";
        const regex = new RegExp(`${startTag}[\\s\\S]*${endTag}`);
        const newReadme = readme.replace(regex, `${startTag}\n\n### 📡 接口实时状态\n更新时间: ${nowCST}\n\n${table}\n\n${endTag}`);
        fs.writeFileSync(README_PATH, newReadme);
    }

    console.log("✅ 报告与 README 已更新");
})();
