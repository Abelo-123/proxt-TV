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

  proxy(
    (() => {
      try {
        const url = new URL(targetUrl);
        return `${url.protocol}//${url.host}`;
      } catch (err) {
        console.warn("Invalid stream URL. Falling back to tvpass.org");
        return "https://tvpass.org";
      }
    })(),
    {
      proxyReqPathResolver: (req) => {
        const url = new URL(req.query.url);
        return url.pathname + url.search;
      },
      proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
        const streamUrl = srcReq.query.url;
        if (streamUrl) {
          const urlObj = new URL(streamUrl);
          proxyReqOpts.headers["Host"] = urlObj.host;

          // Special handling for edgenextcdn
          if (streamUrl.includes("edgenextcdn.net")) {
            proxyReqOpts.headers["Referer"] = "https://www.shahid.net/";
            proxyReqOpts.headers["User-Agent"] =
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
            proxyReqOpts.headers["Origin"] = "https://www.shahid.net";
            if (srcReq.headers.cookie) {
              proxyReqOpts.headers["Cookie"] = srcReq.headers.cookie;
            }
          }
        }
        return proxyReqOpts;
      },
      preserveHostHdr: true,

      userResDecorator: function (proxyRes, proxyResData, req, res) {
        const originalUrl = req.query.url;

        // Only rewrite .m3u8 playlists
        if (originalUrl && originalUrl.endsWith(".m3u8")) {
          let playlist = proxyResData.toString("utf8");

          console.log(`🎯 Rewriting playlist for: ${originalUrl}`);

          playlist = playlist.replace(/^(?!#)(.+)$/gm, (line) => {
            if (line.startsWith("#") || !line.trim()) return line;

            let baseUrl = originalUrl;
            let newUrl;
            try {
              const base = new URL(baseUrl);

              // If it's already a full URL
              if (/^https?:\/\//.test(line)) {
                newUrl = `/proxy?url=${encodeURIComponent(line)}`;
              }
              // If it's a root-relative path (e.g., /live/segment.ts)
              else if (line.startsWith("/")) {
                newUrl = `/proxy?url=${encodeURIComponent(
                  `${base.protocol}//${base.host}${line}`
                )}`;
              }
              // Otherwise, treat it as a relative path
              else {
                const resolved = new URL(line, base).toString();
                newUrl = `/proxy?url=${encodeURIComponent(resolved)}`;
              }

              return newUrl;
            } catch (e) {
              console.warn("⚠️ Failed to resolve playlist line:", line);
              return line;
            }
          });

          console.log("✅ Final rewritten playlist:\n", playlist);

          res.setHeader("content-type", "application/vnd.apple.mpegurl");
          return playlist;
        }

        return proxyResData;
      },

      proxyErrorHandler(err, res, next) {
        console.error("❌ Stream proxy error:", err.message);
        res.status(500).send("Stream proxy failed");
      },
    }
  )(req, res, next);
});

// Dynamic EPG proxy: /epg?channel=CHANNEL_ID&format=json
app.get("/epg", async (req, res) => {
  const channelFilter = req.query.channel;
  const format = req.query.format || "xml";
  const epgUrl = "https://tvpass.org/epg.xml";

  if (!channelFilter) {
    console.warn("Missing 'channel' parameter");
    return res.status(400).send("Missing 'channel' query param");
  }

  try {
    console.log(`🔍 Fetching EPG data for channel: ${channelFilter}`);
    const response = await axios.get(epgUrl, { responseType: "text" });
    const xmlData = response.data;

    const parsed = await parseStringPromise(xmlData, { mergeAttrs: true });

    if (!parsed.tv) return res.status(500).send("Invalid EPG format");

    const allProgrammes = parsed.tv.programme || [];
    const filteredProgrammes = allProgrammes.filter(
      (p) => p.channel && p.channel[0] === channelFilter
    );

    if (format === "json") {
      const jsonEPG = {
        channel: channelFilter,
        programmes: filteredProgrammes.map((p) => ({
          start: p.start?.[0] || null,
          stop: p.stop?.[0] || null,
          title: p.title?.[0] || null,
          subTitle: p["sub-title"]?.[0] || null,
          desc: p.desc?.[0] || null,
        })),
      };
      res.set("Content-Type", "application/json");
      res.json(jsonEPG);
    } else {
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

// Fallback route for manifest requests if needed
app.use("/manifest", (req, res, next) => {
  const baseStreamHost = "https://shd-gcp-live.edgenextcdn.net";
  const fullUrl = `${baseStreamHost}${req.originalUrl}`;
  req.query.url = fullUrl;
  app._router.handle(req, res, next);
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Proxy server running on http://localhost:${PORT}`);
  console.log("🔁 Stream proxy:  /proxy?url=...");
  console.log("📅 EPG XML proxy: /epg?channel=...&format=json");
});
