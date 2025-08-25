// proxy.js (stream-safe + dynamic EPG support)
import express from "express";
import cors from "cors";
import proxy from "express-http-proxy";
import axios from "axios";
import { parseStringPromise, Builder } from "xml2js";

const app = express();
const PORT = 8080;

app.use(cors());

// Generic stream proxy: /proxy?url=https://...
app.use("/proxy", (req, res, next) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing url param");

    proxy((() => {
        try {
            const url = new URL(targetUrl);
            return `${url.protocol}//${url.host}`;
        } catch (err) {
            console.warn("Invalid stream URL. Falling back to tvpass.org");
            return "https://tvpass.org";
        }
    })(), {
        proxyReqPathResolver: (req) => {
            // Forward the full path and query string from the original URL
            const url = new URL(req.query.url);
            return url.pathname + url.search;
        },
        proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
            // Always set custom headers for edgenextcdn.net
            if (targetUrl.includes("edgenextcdn.net")) {
                proxyReqOpts.headers['Referer'] = "https://www.shahid.net/";
                proxyReqOpts.headers['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
                proxyReqOpts.headers['Origin'] = "https://www.shahid.net";
                // Forward cookies if present
                if (srcReq.headers.cookie) {
                    proxyReqOpts.headers['Cookie'] = srcReq.headers.cookie;
                }
            }
            return proxyReqOpts;
        },
        preserveHostHdr: true,
        proxyErrorHandler(err, res, next) {
            console.error("Stream proxy error:", err);
            res.status(500).send("Stream proxy failed");
        },
    })(req, res, next);
});

// Dynamic EPG proxy: /epg?url=https://...
// Dynamic EPG proxy: /epg?channel=ae-us-eastern-feed&format=json
app.get("/epg", async (req, res) => {
    const channelFilter = req.query.channel;
    const format = req.query.format || "xml"; // default is xml
    const epgUrl = "https://tvpass.org/epg.xml";

    if (!channelFilter) {
        console.warn("Missing 'channel' parameter");
        return res.status(400).send("Missing 'channel' query param");
    }

    try {
        console.log(`🔍 Fetching EPG data for channel: ${channelFilter}`);
        const response = await axios.get(epgUrl, { responseType: "text" });
        const xmlData = response.data;

        // Parse XML to JS object
        const parsed = await parseStringPromise(xmlData, { mergeAttrs: true });

        if (!parsed.tv) return res.status(500).send("Invalid EPG format");

        const allProgrammes = parsed.tv.programme || [];
        const filteredProgrammes = allProgrammes.filter(
            (p) => p.channel && p.channel[0] === channelFilter
        );

        if (format === "json") {
            // Respond with JSON
            const jsonEPG = {
                channel: channelFilter,
                programmes: filteredProgrammes.map((p) => ({
                    start: p.start[0],
                    stop: p.stop[0],
                    title: p.title?.[0] || null,
                    subTitle: p["sub-title"]?.[0] || null,
                    desc: p.desc?.[0] || null,
                })),
            };
            res.set("Content-Type", "application/json");
            res.json(jsonEPG);
        } else {
            // Respond with XML
            const builder = new Builder();
            const filteredXml = builder.buildObject({
                tv: { programme: filteredProgrammes },
            });

            res.set("Content-Type", "application/xml");
            res.send(filteredXml);
        }
    } catch (err) {
        console.error("❌ EPG fetch/filter error:", err.message);
        res.status(500).send("Failed to fetch or parse EPG");
    }
});



app.listen(PORT, () => {
    console.log(`✅ Proxy server running on http://localhost:${PORT}`);
    console.log("🔁 Stream proxy:  /proxy?url=...");
    console.log("📅 EPG XML proxy: /epg?url=...");
});
