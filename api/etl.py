"""
ETL — limpeza e padronização de e-mail/telefone e parse do CSV de leads.

As regras de telefone são as mesmas do painel de aprovados
(etl/extract/alunos_fase2.limpar_telefone): remove não-dígitos, descarta o
código do país 55 e separa em (ddd, numero).
"""

from __future__ import annotations

import csv
import io
import re
from typing import Optional

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def limpar_email(bruto: Optional[str]) -> Optional[str]:
    if not bruto:
        return None
    email = str(bruto).strip().lower()
    return email if EMAIL_RE.match(email) else None


def limpar_telefone(bruto: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """(ddd, numero) — mesma regra do painel de aprovados."""
    if not bruto:
        return None, None
    digitos = "".join(ch for ch in str(bruto) if ch.isdigit())
    if len(digitos) >= 12 and digitos.startswith("55"):
        digitos = digitos[2:]
    if len(digitos) < 3:
        return None, digitos or None
    return digitos[:2], digitos[2:]


def chaves_telefone(ddd: Optional[str], numero: Optional[str]) -> list[str]:
    """
    Chaves de match por telefone. Celulares aparecem ora com o 9º dígito, ora
    sem — indexamos as duas variantes para o join não perder ninguém.
    """
    if not ddd or not numero or len(numero) < 8:
        return []
    chaves = [ddd + numero]
    if len(numero) == 9 and numero.startswith("9"):
        chaves.append(ddd + numero[1:])          # variante sem o 9º dígito
    elif len(numero) == 8:
        chaves.append(ddd + "9" + numero)        # variante com o 9º dígito
    return chaves


def decodificar_csv(conteudo: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return conteudo.decode(enc)
        except UnicodeDecodeError:
            continue
    return conteudo.decode("utf-8", errors="replace")


def parse_csv(conteudo: bytes) -> tuple[list[str], list[dict]]:
    """Retorna (colunas, linhas) do CSV enviado."""
    texto = decodificar_csv(conteudo)
    amostra = texto[:8192]
    try:
        dialeto = csv.Sniffer().sniff(amostra, delimiters=",;\t")
    except csv.Error:
        dialeto = csv.excel
    reader = csv.DictReader(io.StringIO(texto), dialect=dialeto)
    colunas = reader.fieldnames or []
    linhas = [dict(r) for r in reader]
    return colunas, linhas


def preparar_leads(linhas: list[dict], mapeamento: dict) -> list[dict]:
    """
    Aplica o mapeamento de colunas informado no front e normaliza cada lead.

    mapeamento = {
      "email": "Email", "telefone": "Telefone" | None,
      "nome": "Nome" | None, "data": "created_at" | None,
      "perguntas": ["Idade", ...],
    }
    """
    col_email = mapeamento.get("email")
    col_tel = mapeamento.get("telefone")
    col_nome = mapeamento.get("nome")
    col_data = mapeamento.get("data")
    perguntas = mapeamento.get("perguntas") or []

    leads = []
    for i, linha in enumerate(linhas):
        email = limpar_email(linha.get(col_email)) if col_email else None
        ddd, numero = limpar_telefone(linha.get(col_tel)) if col_tel else (None, None)
        respostas = {}
        for p in perguntas:
            v = (linha.get(p) or "").strip()
            respostas[p] = v or None
        leads.append({
            "idx": i,
            "email": email,
            "tel_chaves": chaves_telefone(ddd, numero),
            "telefone_fmt": f"({ddd}) {numero}" if ddd and numero else (numero or ""),
            "nome": (linha.get(col_nome) or "").strip() if col_nome else "",
            "data": (linha.get(col_data) or "").strip() if col_data else "",
            "respostas": respostas,
            "respondeu": any(respostas.values()),
        })
    return leads


def indexar_compradores(compradores: list[dict]) -> tuple[set, set]:
    """Conjuntos de e-mails e chaves de telefone dos compradores (já limpos)."""
    emails, tels = set(), set()
    for c in compradores:
        email = limpar_email(c.get("email"))
        if email:
            emails.add(email)
        ddd, numero = limpar_telefone(c.get("telefone"))
        for chave in chaves_telefone(ddd, numero):
            tels.add(chave)
    return emails, tels


def marcar_compradores(leads: list[dict], emails: set, tels: set) -> dict:
    """Marca lead['comprou'] via e-mail (prioridade) ou telefone."""
    por_email = por_tel = 0
    for lead in leads:
        comprou_email = bool(lead["email"] and lead["email"] in emails)
        comprou_tel = any(k in tels for k in lead["tel_chaves"])
        lead["comprou"] = comprou_email or comprou_tel
        lead["match_via"] = "email" if comprou_email else ("telefone" if comprou_tel else None)
        por_email += comprou_email
        por_tel += (not comprou_email) and comprou_tel
    return {"match_email": por_email, "match_telefone": por_tel}
