"""
Acesso ao banco (RDS — schema plataforma1_espelho, somente leitura) e
modo mock para desenvolvimento sem rede.

Compradores = alunos matriculados (user_on_classroom ativo) na edição OAB /
tipo de turma escolhidos — mesmo caminho usado pelo painel de aprovados.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

MOCK_BUYERS = os.getenv("MOCK_BUYERS", "0") == "1"


def conectar():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME", "postgres"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        sslmode=os.getenv("DB_SSLMODE", "disable"),
        connect_timeout=15,
    )


def listar_turmas() -> list[dict]:
    """Combinações (oab, curso) disponíveis no espelho, com nº de alunos."""
    if MOCK_BUYERS:
        return [
            {"oab": 47, "curso": "90 dias", "alunos": 812},
            {"oab": 46, "curso": "90 dias", "alunos": 1094},
        ]
    sql = """
        SELECT c.oab, c.classroom_type_name AS curso, COUNT(*) AS alunos
        FROM plataforma1_espelho.user_on_classroom uoc
        JOIN plataforma1_espelho.classroom c ON c.id = uoc.classroom_id
        JOIN plataforma1_espelho.user_ u     ON u.id = uoc.user_id
        WHERE u.role = 'STUDENT' AND uoc.status IS TRUE AND c.oab IS NOT NULL
        GROUP BY c.oab, c.classroom_type_name
        ORDER BY c.oab DESC, curso
    """
    with conectar() as conn, conn.cursor(
        cursor_factory=psycopg2.extras.RealDictCursor
    ) as cur:
        cur.execute(sql)
        return [dict(r) for r in cur.fetchall()]


def listar_compradores(oab: int, curso: str) -> list[dict]:
    """E-mail e telefone dos alunos ativos da edição/turma."""
    sql = """
        SELECT DISTINCT
            u.email     AS email,
            u.cellphone AS telefone
        FROM plataforma1_espelho.user_on_classroom uoc
        JOIN plataforma1_espelho.classroom c ON c.id = uoc.classroom_id
        JOIN plataforma1_espelho.user_ u     ON u.id = uoc.user_id
        WHERE u.role = 'STUDENT'
          AND uoc.status IS TRUE
          AND c.oab = %s
          AND c.classroom_type_name = %s
    """
    with conectar() as conn, conn.cursor(
        cursor_factory=psycopg2.extras.RealDictCursor
    ) as cur:
        cur.execute(sql, (oab, curso))
        return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Mock — compradores fictícios determinísticos, só para desenvolvimento local
# ---------------------------------------------------------------------------

def _hash01(texto: str) -> float:
    h = hashlib.md5(texto.encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def mock_compradores(leads: list[dict]) -> list[dict]:
    """
    Amostra ~3% dos leads como "compradores", com viés proposital em algumas
    respostas para o modelo ter sinal detectável. Determinístico (hash do
    e-mail), então a análise é reproduzível. NUNCA usar fora de dev.
    """
    compradores = []
    for lead in leads:
        if not lead["email"]:
            continue
        r = lead["respostas"]
        p = 0.015
        if r.get("Ao final do aulão gratuito, iremos abrir as vagas para Turma de 90 Dias - OAB 47. Você pretende entrar nessa turma?") == "Sim!":
            p += 0.035
        if (r.get("É ou já foi aluno VDE OAB?") or "").startswith("Já"):
            p += 0.04
        if r.get("Há quanto tempo estuda pra OAB?") in ("1 - 2 anos", "2 - 3 anos"):
            p += 0.02
        if r.get("Idade") in ("25-29 anos", "30-34 anos"):
            p += 0.01
        if _hash01(lead["email"]) < p:
            compradores.append({"email": lead["email"], "telefone": ""})
    return compradores
