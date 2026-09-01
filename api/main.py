"""
API do Lead Score Vício.

Fluxo:
  1. GET  /api/turmas                      → turmas (oab × curso) do banco
  2. POST /api/analises                    → CSV + mapeamento → ETL + match + score
  3. GET  /api/analises/{id}               → resumo/estatísticas da análise
  4. GET  /api/analises/{id}/leads         → leads paginados (filtros)
  5. GET  /api/analises/{id}/leads/export  → CSV para o comercial

Rodar:  uvicorn main:app --reload --port 8010  (a partir de api/)
"""

from __future__ import annotations

import io
import csv
import json
import os
import uuid
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

import database
import etl
import scoring

load_dotenv()

app = FastAPI(title="Lead Score Vício", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5175").split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)

# análises em memória (MVP) — {id: {"meta":..., "stats":..., "leads":[...]}}
ANALISES: dict[str, dict] = {}


@app.get("/api/health")
def health():
    return {"ok": True, "mock_buyers": database.MOCK_BUYERS}


@app.get("/api/turmas")
def turmas():
    try:
        return {"turmas": database.listar_turmas(), "mock": database.MOCK_BUYERS}
    except Exception as e:  # banco fora de alcance etc.
        raise HTTPException(502, f"Falha ao consultar o banco: {e}")


@app.post("/api/analises")
async def criar_analise(
    arquivo: UploadFile = File(...),
    mapeamento: str = Form(...),   # JSON — ver etl.preparar_leads
    oab: int = Form(...),
    curso: str = Form(...),
    nome: str = Form(""),
):
    try:
        mapa = json.loads(mapeamento)
    except json.JSONDecodeError:
        raise HTTPException(400, "Mapeamento inválido (JSON malformado).")
    if not mapa.get("email"):
        raise HTTPException(400, "Informe qual coluna contém o e-mail do lead.")
    if not mapa.get("perguntas"):
        raise HTTPException(400, "Selecione ao menos uma pergunta da pesquisa.")

    conteudo = await arquivo.read()
    colunas, linhas = etl.parse_csv(conteudo)
    if not linhas:
        raise HTTPException(400, "CSV vazio ou ilegível.")
    faltando = [c for c in [mapa.get("email"), *(mapa.get("perguntas") or [])] if c and c not in colunas]
    if faltando:
        raise HTTPException(400, f"Colunas não encontradas no CSV: {faltando}")

    leads = etl.preparar_leads(linhas, mapa)

    if database.MOCK_BUYERS:
        compradores = database.mock_compradores(leads)
    else:
        try:
            compradores = database.listar_compradores(oab, curso)
        except Exception as e:
            raise HTTPException(502, f"Falha ao buscar compradores no banco: {e}")

    emails, tels = etl.indexar_compradores(compradores)
    match_info = etl.marcar_compradores(leads, emails, tels)
    stats = scoring.analisar(leads, mapa["perguntas"])

    analise_id = uuid.uuid4().hex[:12]
    ANALISES[analise_id] = {
        "meta": {
            "id": analise_id,
            "nome": nome or f"OAB {oab} — {curso}",
            "arquivo": arquivo.filename,
            "oab": oab,
            "curso": curso,
            "criada_em": datetime.now().isoformat(timespec="seconds"),
            "compradores_banco": len(compradores),
            "mock": database.MOCK_BUYERS,
            **match_info,
        },
        "stats": stats,
        "leads": leads,
    }
    return {"id": analise_id, "meta": ANALISES[analise_id]["meta"], "stats": stats}


@app.get("/api/analises")
def listar_analises():
    return {"analises": [a["meta"] for a in ANALISES.values()]}


def _analise(analise_id: str) -> dict:
    analise = ANALISES.get(analise_id)
    if not analise:
        raise HTTPException(404, "Análise não encontrada (a API guarda em memória — reenvie o CSV).")
    return analise


@app.get("/api/analises/{analise_id}")
def detalhe(analise_id: str):
    a = _analise(analise_id)
    return {"meta": a["meta"], "stats": a["stats"]}


@app.get("/api/analises/{analise_id}/leads")
def leads(
    analise_id: str,
    classe: str | None = None,
    busca: str | None = None,
    sem_compradores: bool = False,
    pagina: int = 1,
    por_pagina: int = 50,
):
    a = _analise(analise_id)
    itens = a["leads"]
    if sem_compradores:
        itens = [l for l in itens if not l["comprou"]]
    if classe in ("hot", "warm", "cold"):
        itens = [l for l in itens if l["classe"] == classe]
    if busca:
        b = busca.strip().lower()
        itens = [l for l in itens if b in (l["email"] or "") or b in l["nome"].lower()]
    itens = sorted(itens, key=lambda l: -l["score"])
    total = len(itens)
    ini = (max(pagina, 1) - 1) * por_pagina
    return {
        "total": total,
        "pagina": pagina,
        "por_pagina": por_pagina,
        "leads": [
            {k: v for k, v in l.items() if k not in ("tel_chaves",)}
            for l in itens[ini: ini + por_pagina]
        ],
    }


@app.get("/api/analises/{analise_id}/leads/export")
def exportar(analise_id: str, classe: str | None = None, sem_compradores: bool = False):
    a = _analise(analise_id)
    itens = a["leads"]
    if sem_compradores:
        itens = [l for l in itens if not l["comprou"]]
    if classe in ("hot", "warm", "cold"):
        itens = [l for l in itens if l["classe"] == classe]
    itens = sorted(itens, key=lambda l: -l["score"])
    perguntas = [p["pergunta"] for p in a["stats"]["perguntas"]]

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["nome", "email", "telefone", "score", "classe", "comprou", *perguntas])
    for l in itens:
        w.writerow([
            l["nome"], l["email"] or "", l["telefone_fmt"], l["score"], l["classe"],
            "sim" if l["comprou"] else "nao",
            *[l["respostas"].get(p) or "" for p in perguntas],
        ])
    buf.seek(0)
    sufixo = f"_{classe}" if classe else ""
    return StreamingResponse(
        iter([buf.getvalue().encode("utf-8-sig")]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="leadscore_{a["meta"]["oab"]}{sufixo}.csv"'},
    )
