const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });
 
function requiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
    }
    return value;
}
 
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/paginainicial.html'));
});
 
// Inicialização do Supabase
const supabaseUrl = requiredEnv('SUPABASE_URL');
const supabaseKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
 
const PORT = process.env.PORT || 3001;
const visualizacaoEmMemoria = new Map();

async function getVisualizacaoAtual(noticiaId) {
    const chave = String(noticiaId);
    const atualEmMemoria = visualizacaoEmMemoria.get(chave) ?? 0;

    try {
        const { data, error } = await supabase
            .from('pesquisas_politicas')
            .select('visualizacoes')
            .eq('id', noticiaId)
            .single();

        if (!error && data && typeof data.visualizacoes === 'number') {
            visualizacaoEmMemoria.set(chave, data.visualizacoes);
            return data.visualizacoes;
        }
    } catch (err) {
        // Fallback silencioso quando a coluna ainda não existe no banco.
    }

    return atualEmMemoria;
}

async function incrementarVisualizacao(noticiaId) {
    const chave = String(noticiaId);

    try {
        const { data, error } = await supabase.rpc('incrementar_visualizacoes', {
            noticia_id: noticiaId
        });

        if (!error) {
            const novoTotal = Array.isArray(data) ? data[0] : data;
            if (novoTotal !== null && novoTotal !== undefined) {
                const total = Number(novoTotal);
                visualizacaoEmMemoria.set(chave, total);
                return total;
            }
        }

        if (error) {
            console.warn(`Fallback de visualização para ${noticiaId}:`, error.message);
        }
    } catch (err) {
        console.warn(`Fallback de visualização para ${noticiaId}:`, err.message);
    }

    // Mantém a persistência mesmo quando a função RPC ainda não foi criada.
    try {
        const { data: noticia, error: selectError } = await supabase
            .from('pesquisas_politicas')
            .select('visualizacoes')
            .eq('id', noticiaId)
            .single();

        if (!selectError && noticia) {
            const totalAtual = Number(noticia.visualizacoes) || 0;
            const novoTotal = totalAtual + 1;
            const { error: updateError } = await supabase
                .from('pesquisas_politicas')
                .update({ visualizacoes: novoTotal })
                .eq('id', noticiaId);

            if (!updateError) {
                visualizacaoEmMemoria.set(chave, novoTotal);
                return novoTotal;
            }

            console.warn(`Não foi possível salvar visualização de ${noticiaId}:`, updateError.message);
        }
    } catch (err) {
        console.warn(`Fallback de banco indisponível para ${noticiaId}:`, err.message);
    }

    const totalEmMemoria = visualizacaoEmMemoria.get(chave) ?? 0;
    const novoTotalEmMemoria = totalEmMemoria + 1;
    visualizacaoEmMemoria.set(chave, novoTotalEmMemoria);
    return novoTotalEmMemoria;
}

// Feed já pré-filtrado pelo Google News para política + Espírito Santo.
// Isso reduz o volume de itens irrelevantes antes mesmo do filtro local.
const newsFeedUrl = 'https://news.google.com/rss/search?q=politica+%22Esp%C3%ADrito+Santo%22&hl=pt-BR&gl=BR&ceid=BR:pt-419';
 
const fallbackNews = [
    {
        titulo: 'Assembleia Legislativa do Espírito Santo aprova novas regras de transparência',
        url: 'https://www.al.es.gov.br/noticia/exemplo',
        snippet: 'ALES aprova projeto que amplia transparência sobre emendas parlamentares no estado.',
        categoria: 'deputado',
        partido: 'Geral',
        data_publicacao: '2026-06-01',
        imagem_url: null
    },
    {
        titulo: 'Governo do Espírito Santo anuncia medidas econômicas para o estado',
        url: 'https://www.es.gov.br/noticia/exemplo',
        snippet: 'Governador destaca avanços econômicos e metas fiscais para o segundo semestre no ES.',
        categoria: 'governador',
        partido: 'Executivo',
        data_publicacao: '2026-06-02',
        imagem_url: null
    }
];
 
// ---------------------------------------------------------------------------
// FILTRAGEM E CLASSIFICAÇÃO DE CONTEÚDO POLÍTICO
// ---------------------------------------------------------------------------
 
const POLITICAL_KEYWORDS = [
    'política', 'politica', 'governo', 'congresso', 'câmara', 'camara',
    'senado', 'deputado', 'senador', 'ministro', 'ministério', 'ministerio',
    'presidente', 'presidência', 'presidencia', 'planalto', 'eleição', 'eleicao',
    'eleições', 'eleicoes', 'partido', 'votação', 'votacao', 'projeto de lei',
    'plenário', 'plenario', 'stf', 'tse', 'governador', 'prefeito', 'vereador',
    'reforma', 'oposição', 'oposicao', 'base aliada', 'gabinete', 'coligação',
    'coligacao', 'cpi', 'impeachment'
];
 
// ---------------------------------------------------------------------------
// FILTRO GEOGRÁFICO: ESPÍRITO SANTO
// ---------------------------------------------------------------------------
// Termos que indicam que a notícia é sobre o estado do Espírito Santo:
// o nome do estado, sigla em contexto claro, a assembleia legislativa
// estadual (ALES) e os principais municípios capixabas. Uma notícia só
// é aceita se contiver política E algum desses termos.
const ES_KEYWORDS = [
    'espírito santo', 'espirito santo', 'capixaba', 'capixabas',
    'ales', 'assembleia legislativa do espírito santo', 'assembleia legislativa do espirito santo',
    'governo do estado do espírito santo', 'governo do estado do espirito santo',
    'vitória', 'vitoria-es', 'vila velha', 'serra-es', 'cariacica',
    'cachoeiro de itapemirim', 'linhares', 'colatina', 'guarapari',
    'aracruz', 'ibiraçu', 'ibiracu', 'são mateus', 'sao mateus',
    'nova venécia', 'nova venecia', 'barra de são francisco', 'barra de sao francisco',
    'viana-es', 'marataízes', 'marataizes', 'piúma', 'piuma', 'anchieta-es',
    'domingos martins', 'santa teresa-es', 'santa maria de jetibá', 'santa maria de jetiba',
    'grande vitória', 'grande vitoria'
];
 
const CATEGORY_RULES = [
    { categoria: 'presidente', termos: ['presidente', 'presidência', 'presidencia', 'planalto'] },
    { categoria: 'ministro', termos: ['ministro', 'ministra', 'ministério', 'ministerio'] },
    { categoria: 'senador', termos: ['senador', 'senadora', 'senado federal'] },
    { categoria: 'deputado', termos: [
        'deputado', 'deputada', 'câmara dos deputados', 'camara dos deputados',
        'ales', 'assembleia legislativa do espírito santo', 'assembleia legislativa do espirito santo',
        'deputado estadual', 'deputada estadual'
    ] },
    { categoria: 'governador', termos: ['governador', 'governadora', 'governo estadual', 'governo do espírito santo', 'governo do espirito santo'] },
    { categoria: 'prefeito', termos: ['prefeito', 'prefeita', 'prefeitura', 'vereador', 'vereadora'] },
    { categoria: 'judiciario', termos: ['stf', 'supremo tribunal', 'tse', 'tribunal', 'ministro do stf', 'tjes', 'tribunal de justiça do espírito santo'] },
    { categoria: 'eleicoes', termos: ['eleição', 'eleicao', 'eleições', 'eleicoes', 'candidato', 'candidata', 'urna', 'votação', 'votacao'] }
];
 
const PARTY_LIST = [
    'PT', 'PL', 'PSDB', 'MDB', 'PP', 'REPUBLICANOS', 'PSOL', 'PDT', 'PSD',
    'UNIÃO BRASIL', 'UNIAO BRASIL', 'NOVO', 'PCDOB', 'PSB', 'PODEMOS',
    'CIDADANIA', 'AVANTE', 'SOLIDARIEDADE', 'PROS', 'PATRIOTA', 'PV', 'REDE'
];
 
function isPoliticalContent(text) {
    const normalized = text.toLowerCase();
    return POLITICAL_KEYWORDS.some((termo) => normalized.includes(termo));
}
 
// Retorna true se o texto menciona o Espírito Santo (estado, sigla em
// contexto claro, ALES ou algum dos principais municípios capixabas).
function isEspiritoSantoContent(text) {
    const normalized = text.toLowerCase();
    return ES_KEYWORDS.some((termo) => normalized.includes(termo));
}
 
function classifyCategoria(text) {
    const normalized = text.toLowerCase();
    for (const rule of CATEGORY_RULES) {
        if (rule.termos.some((termo) => normalized.includes(termo))) {
            return rule.categoria;
        }
    }
    return 'geral';
}
 
function classifyPartido(text) {
    const upper = text.toUpperCase();
    const encontrados = PARTY_LIST.filter((sigla) => {
        const escaped = sigla.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[^A-ZÀ-Ú])${escaped}([^A-ZÀ-Ú]|$)`);
        return regex.test(upper);
    });
    return encontrados.length > 0 ? encontrados.join(', ') : 'Geral';
}
 
// ---------------------------------------------------------------------------
// EXTRAÇÃO DE IMAGEM DA NOTÍCIA
// ---------------------------------------------------------------------------
 
// Busca a imagem principal de uma página de notícia: primeiro tenta as meta
// tags padrão (og:image / twitter:image), que é onde praticamente todo site
// de notícia declara a imagem de capa do artigo. Se não achar, cai para a
// primeira <img> dentro de <article> e, por último, a primeira <img> da página.
async function extractArticleImage(url) {
    try {
        const response = await axios.get(url, {
            timeout: 8000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SPP/1.0 NewsBot'
            }
        });
 
        // URL final após seguir redirecionamentos (importante para o link do
        // Google News, que costuma redirecionar para o site de origem).
        const finalUrl = response.request?.res?.responseUrl || url;
        const $ = cheerio.load(response.data);
 
        const imageSrc =
            $('meta[property="og:image"]').attr('content') ||
            $('meta[property="og:image:secure_url"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') ||
            $('meta[name="twitter:image:src"]').attr('content') ||
            $('article img').first().attr('src') ||
            $('img').first().attr('src');
 
        if (!imageSrc) return null;
 
        // Resolve URLs relativas (ex.: "/imagens/foto.jpg") para absolutas
        return new URL(imageSrc, finalUrl).href;
    } catch (error) {
        console.warn(`Não foi possível extrair imagem de ${url}: ${error.message}`);
        return null;
    }
}
 
// Limitador de concorrência simples (sem dependência extra tipo p-limit):
// processa a lista em paralelo, mas no máximo `limit` requisições por vez,
// pra não abrir 30 conexões simultâneas e não tomar rate-limit dos sites.
async function mapWithConcurrency(items, limit, worker) {
    let index = 0;
 
    async function run() {
        while (index < items.length) {
            const current = index++;
            await worker(items[current], current);
        }
    }
 
    const workers = Array.from({ length: Math.min(limit, items.length) }, run);
    await Promise.all(workers);
}
 
// ---------------------------------------------------------------------------
// RESUMO DA NOTÍCIA
// ---------------------------------------------------------------------------
 
// Busca um resumo da notícia direto na página de origem: primeiro tenta a
// meta description / og:description (o próprio site já resume a matéria),
// e se não achar, cai para os primeiros parágrafos do corpo do texto.
async function extractArticleSummary(url) {
    try {
        const response = await axios.get(url, {
            timeout: 8000,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SPP/1.0 NewsBot'
            }
        });
        const $ = cheerio.load(response.data);
 
        let resumo =
            $('meta[name="description"]').attr('content') ||
            $('meta[property="og:description"]').attr('content');
 
        if (!resumo || resumo.trim().length < 40) {
            const paragrafos = $('article p, .post-content p, .entry-content p, p')
                .map((_, el) => $(el).text().trim())
                .get()
                .filter((t) => t.length > 40);
            resumo = paragrafos.slice(0, 3).join(' ');
        }
 
        if (!resumo) return null;
 
        // Limita o tamanho para não guardar textos gigantes no banco
        return resumo.trim().slice(0, 600);
    } catch (error) {
        console.warn(`Não foi possível extrair resumo de ${url}: ${error.message}`);
        return null;
    }
}
 
// ---------------------------------------------------------------------------
 
async function ingestNews() {
    let news = [];
 
    try {
        const response = await axios.get(newsFeedUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'SPP/1.0' }
        });
        const $ = cheerio.load(response.data, { xmlMode: true });
 
        $('item').slice(0, 30).each((index, element) => {
            const title = $(element).find('title').first().text().trim();
            const url = $(element).find('link').first().text().trim();
            const snippet = $(element).find('description').first().text().trim();
            const publishedAt = $(element).find('pubDate').first().text().trim();
            const date = publishedAt ? new Date(publishedAt) : new Date();
            const fullText = `${title} ${snippet}`;
 
            // Só entra se for conteúdo político E mencionar o Espírito Santo.
            if (!title || !url || !isPoliticalContent(fullText) || !isEspiritoSantoContent(fullText)) {
                return;
            }
 
            news.push({
                titulo: title,
                url,
                snippet: snippet || title,
                categoria: classifyCategoria(fullText),
                partido: classifyPartido(fullText),
                data_publicacao: Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10),
                imagem_url: null
            });
        });
    } catch (error) {
        console.error('Não foi possível ler o RSS de notícias:', error.message);
    }
 
    const records = news.length > 0 ? news : fallbackNews;
 
    // Busca a imagem de cada notícia em paralelo (5 por vez) antes de salvar.
    await mapWithConcurrency(records, 5, async (item) => {
        item.imagem_url = await extractArticleImage(item.url);
    });
 
    const { error } = await supabase
        .from('pesquisas_politicas')
        .upsert(records, { onConflict: 'url' });
 
    if (error) throw error;
    return records.length;
}
 
// Rota de Ingestão e Processamento (Scraper -> JSON -> Supabase)
app.post('/api/ingest', async (req, res) => {
    try {
        const count = await ingestNews();
        res.json({ success: true, message: 'Notícias processadas e salvas com sucesso!', count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});
 
// Rota da SERP (Search Engine Results Page) com Filtros e Busca Textual
app.get('/api/search', async (req, res) => {
    const startTime = Date.now();
    const { q = '', categoria = '', partido = '', ordenacao = 'relevancia' } = req.query;
 
    try {
        let query = supabase
            .from('pesquisas_politicas')
            .select('*', { count: 'exact' });
 
        if (q.trim() !== '') {
            query = query.or(`titulo.ilike.%${q}%,snippet.ilike.%${q}%`);
        }
 
        if (categoria && categoria !== 'todos') {
            query = query.eq('categoria', categoria);
        }
 
        if (partido && partido !== 'todos') {
            query = query.ilike('partido', `%${partido}%`);
        }
 
        query = query.order('data_publicacao', { ascending: ordenacao === 'data_antiga' });
 
        // Registros antigos também precisam respeitar o recorte do Espírito Santo.
        // A filtragem acontece antes do limite para não devolver menos resultados
        // quando houver notícias de outras localidades no banco.
        query = query.limit(1000);
 
        const { data: fetchedData, error } = await query;
 
        if (error) throw error;
 
        const data = [];

        for (const noticia of (fetchedData || [])
            .filter((item) => {
                const fullText = `${item.titulo || ''} ${item.snippet || ''}`;
                return isPoliticalContent(fullText) && isEspiritoSantoContent(fullText);
            })
            .slice(0, 10)) {
            data.push({
                ...noticia,
                visualizacoes: await getVisualizacaoAtual(noticia.id)
            });
        }

        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;
 
        res.json({
            total: data.length,
            tempoBusca: `${duration.toFixed(3)} segundos`,
            resultados: data
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro ao realizar a busca no banco de dados." });
    }
});
 
// Rota do botão "Saiba mais":
// 1) Se a notícia já tem resumo salvo no Supabase, devolve na hora (cache).
// 2) Se não tem, busca no site de origem, salva no banco e devolve.
app.get('/api/noticias/:id/resumo', async (req, res) => {
    const { id } = req.params;
 
    try {
        const { data: noticia, error } = await supabase
            .from('pesquisas_politicas')
            .select('id, url, resumo')
            .eq('id', id)
            .single();
 
        if (error || !noticia) {
            return res.status(404).json({ erro: 'Notícia não encontrada' });
        }
 
        if (noticia.resumo) {
            return res.json({ resumo: noticia.resumo, origem: 'cache' });
        }
 
        const resumo = await extractArticleSummary(noticia.url);
 
        if (!resumo) {
            return res.status(422).json({ erro: 'Não foi possível gerar um resumo para essa notícia' });
        }
 
        const { error: updateError } = await supabase
            .from('pesquisas_politicas')
            .update({ resumo, resumo_atualizado_em: new Date().toISOString() })
            .eq('id', id);
 
        if (updateError) throw updateError;
 
        res.json({ resumo, origem: 'site' });
    } catch (err) {
        console.error('Erro ao gerar resumo:', err.message);
        res.status(500).json({ erro: 'Erro ao gerar resumo' });
    }
});
 
// ---------------------------------------------------------------------------
// CONTADOR DE VISUALIZAÇÕES
// ---------------------------------------------------------------------------
// Chamada pelo frontend quando o usuário clica em uma notícia. Incrementa o
// contador de visualizações direto no banco (via função RPC no Postgres,
// veja migration.sql) para evitar condição de corrida quando várias pessoas
// clicam ao mesmo tempo — em vez de ler o valor em JS, somar 1 e regravar,
// o que poderia perder incrementos concorrentes.
app.post('/api/noticias/:id/visualizar', async (req, res) => {
    const { id } = req.params;

    try {
        const novoTotal = await incrementarVisualizacao(id);
        res.json({ id, visualizacoes: novoTotal });
    } catch (err) {
        console.error('Erro ao registrar visualização:', err.message);
        res.status(500).json({ erro: 'Erro ao registrar visualização' });
    }
});
 
async function startServer() {
    try {
        const count = await ingestNews();
        console.log(`${count} notícias carregadas automaticamente.`);
    } catch (error) {
        console.error('Falha na ingestão automática:', error.message);
    }
 
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}
 
startServer();
 