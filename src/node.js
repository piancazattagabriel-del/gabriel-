const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/paginainicial.html'));
});

// Inicialização do Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const PORT = process.env.PORT || 3001;
const newsFeedUrl = 'https://news.google.com/rss/search?q=politica+Brasil&hl=pt-BR&gl=BR&ceid=BR:pt-419';

const fallbackNews = [
    {
        titulo: 'Agricultora de Formosa é eleita pela Forbes como umas das mulheres mais poderosas do Brasil',
        url: 'https://g1.globo.com/go/goias/noticia/2026/08/24/agricultora-de-formosa-e-eleita-pela-forbes-como-umas-das-mulheres-mais-poderosas-do-brasil.ghtml',
        snippet: 'Câmara dos Deputados aprova novas regras de transparência para emendas parlamentares e repasses.',
        categoria: 'deputado',
        partido: 'Geral',
        data_publicacao: '2026-06-01'
    },
    {
        titulo: 'Pronunciamento oficial do Presidente sobre reformas estruturais',
        url: 'https://www.gov.br/presidencia/noticias/exemplo',
        snippet: 'Em discurso no Planalto, o Presidente destacou os avanços econômicos e metas fiscais para o segundo semestre.',
        categoria: 'presidente',
        partido: 'Executivo',
        data_publicacao: '2026-06-02'
    }
];

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

            if (title && url) {
                news.push({
                    titulo: title,
                    url,
                    snippet: snippet || title,
                    categoria: 'geral',
                    partido: 'Geral',
                    data_publicacao: Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10)
                });
            }
        });
    } catch (error) {
        console.error('Não foi possível ler o RSS de notícias:', error.message);
    }

    const records = news.length > 0 ? news : fallbackNews;
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
        let query = supabase.from('pesquisas_politicas').select('*');

        // Busca textual por palavra-chave no título ou snippet
        if (q.trim() !== '') {
            query = query.or(`titulo.ilike.%${q}%,snippet.ilike.%${q}%`);
        }

        // Filtro por categoria (presidente, deputado, etc.)
        if (categoria && categoria !== 'todos') {
            query = query.eq('categoria', categoria);
        }

        // Filtro por partido
        if (partido && partido !== 'todos') {
            query = query.ilike('partido', `%${partido}%`);
        }

        query = query
            .order('data_publicacao', { ascending: false })
            .limit(10);

        const { data, error, count } = await query;

        if (error) throw error;

        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000; // em segundos

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