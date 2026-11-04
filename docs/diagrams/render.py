import sys, glob, pathlib
from playwright.sync_api import sync_playwright
files = sys.argv[1:] or sorted(glob.glob("*.mmd"))
HTML = """<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#fff;font-family:'BIZ UDPGothic',sans-serif} #w{display:inline-block;padding:24px} #b:empty{display:none} #b{margin:0 0 16px;padding:14px 20px;border:4px solid #dc2626;background:#fee2e2;color:#7f1d1d;font-weight:bold;font-size:22px;border-radius:6px}</style>
</head>
<body><div id="w"><div id="b"></div><div id="d"></div></div><script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
import elk from 'https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.1.7/dist/mermaid-layout-elk.esm.min.mjs';
mermaid.registerLayoutLoaders(elk);
window.mermaid = mermaid;
mermaid.initialize({startOnLoad:false, theme:'base', securityLevel:'loose',
  themeVariables:{fontFamily:"'BIZ UDPGothic',sans-serif", fontSize:'16px', lineColor:'#475569'},
  flowchart:{useMaxWidth:false, htmlLabels:true, curve:'basis', nodeSpacing:40, rankSpacing:56, padding:16, wrappingWidth:400, subGraphTitleMargin:{top:10, bottom:14}}, block:{useMaxWidth:false, padding:12}});
window.draw = async (src, banner) => { document.getElementById('b').textContent = banner; const {svg} = await mermaid.render('g', src); document.getElementById('d').innerHTML = svg; };
</script></body></html>"""
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(device_scale_factor=2, viewport={"width": 4000, "height": 1000})
    pg.set_content(HTML); pg.wait_for_function("!!window.draw")
    for f in files:
        src = pathlib.Path(f).read_text()
        banner = " ".join(l.split("banner:", 1)[1].strip() for l in src.splitlines() if l.startswith("%% banner:"))
        pg.evaluate("([s, b]) => draw(s, b)", [src, banner])
        pg.evaluate("document.fonts.ready")
        out = f.replace(".mmd", ".png")
        pg.locator("#w").screenshot(path=out)
        print("wrote", out)
    b.close()
