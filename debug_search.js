const fs = require('fs');

async function testSearch(query) {
    try {
        console.log(`Searching for: ${query}`);
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://html.duckduckgo.com/'
            }
        });
        
        if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);
        
        const html = await response.text();
        console.log(`Response length: ${html.length}`);
        
        // Debug: Write HTML to file to inspect
        fs.writeFileSync('debug_search.html', html);

        const results = [];
        
        // Strategy 1: Split by result__body (simple, robust)
        const bodies = html.split('class="result__body"');
        console.log(`Found ${bodies.length - 1} potential result bodies.`);

        const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
        const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

        for (let i = 1; i < bodies.length; i++) {
            if (results.length >= 5) break;
            
            const block = bodies[i];
            const linkMatch = linkRegex.exec(block);
            const snippetMatch = snippetRegex.exec(block);
            
            if (linkMatch) {
                let url = linkMatch[1];
                let title = linkMatch[2];
                let snippet = snippetMatch ? snippetMatch[1] : '';

                // Decode URL if it's a DDG redirect
                if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
                    try {
                        const urlObj = new URL('https:' + url);
                        const uddg = urlObj.searchParams.get('uddg');
                        if (uddg) url = decodeURIComponent(uddg);
                    } catch (e) {
                         console.log('Failed to decode DDG link:', url);
                    }
                }

                const cleanText = (str) => str
                    .replace(/<[^>]+>/g, '') 
                    .replace(/&quot;/g, '"')
                    .replace(/&#x27;/g, "'")
                    .replace(/&amp;/g, '&')
                    .trim();

                title = cleanText(title);
                snippet = cleanText(snippet);

                if (url && title) {
                    results.push({ url, title, snippet });
                }
            } else {
                console.log(`Block ${i} failed regex match.`);
            }
        }
        
        console.log('Results:', results);
        return results;

    } catch (error) {
        console.error('Search error:', error);
    }
}

testSearch('linux mint vs pop os');
