"""
Modelo de Lead Score — regras de negócio explicáveis.

Metodologia (MVP):
  1. Para cada pergunta fechada e cada resposta: taxa de conversão observada
     (compradores / leads que deram aquela resposta) e LIFT em relação à taxa
     base da lista.
  2. Peso da resposta = log-verossimilhança (log do lift suavizado). Respostas
     que convertem acima da média somam pontos; abaixo da média, subtraem.
  3. Score do lead = soma dos pesos das suas respostas, convertida para 0–100
     via percentil na própria base (score 90 = lead melhor que 90% da lista).
  4. Relevância da pergunta = V de Cramér (força da associação resposta × compra).
  5. Calibração: taxa de conversão real por faixa de score (decis) — é isso que
     dá previsibilidade de conversão/faturamento em lançamentos futuros.

Classificação: hot (score >= 80), warm (50–79), cold (< 50).
"""

from __future__ import annotations

import math
from bisect import bisect_left
from collections import defaultdict

SUAVIZACAO = 5          # leads "virtuais" por resposta (evita peso explosivo em amostra pequena)
MIN_AMOSTRA = 30        # nº mínimo de leads para uma resposta entrar no ranking de impulsionadores
MAX_RESPOSTAS = 30      # acima disso a pergunta é considerada aberta e fica fora do modelo
HOT = 80
WARM = 50
SEM_RESPOSTA = "(não respondeu)"


def _cramers_v(tabela: dict[str, tuple[int, int]], total: int, total_compras: int) -> float:
    """V de Cramér para tabela resposta × comprou (2 colunas)."""
    if total == 0 or total_compras == 0 or total_compras == total or len(tabela) < 2:
        return 0.0
    chi2 = 0.0
    for _, (n, compras) in tabela.items():
        if n == 0:
            continue
        for obs, prop in ((compras, total_compras / total), (n - compras, 1 - total_compras / total)):
            esperado = n * prop
            if esperado > 0:
                chi2 += (obs - esperado) ** 2 / esperado
    return math.sqrt(chi2 / total)  # min(dims)-1 == 1


def analisar(leads: list[dict], perguntas: list[str]) -> dict:
    """Calcula estatísticas, pesos, scores e calibração. Muta os leads (score)."""
    total = len(leads)
    compras_total = sum(1 for l in leads if l["comprou"])
    taxa_base = compras_total / total if total else 0.0

    # perguntas abertas (texto livre) não entram no modelo de pesos
    descartadas = []
    fechadas = []
    for pergunta in perguntas:
        distintas = {l["respostas"].get(pergunta) for l in leads if l["respostas"].get(pergunta)}
        if len(distintas) > MAX_RESPOSTAS:
            descartadas.append({"pergunta": pergunta, "respostas_distintas": len(distintas)})
        else:
            fechadas.append(pergunta)
    perguntas = fechadas

    # --- estatísticas por pergunta/resposta -------------------------------
    stats_perguntas = []
    pesos: dict[str, dict[str, float]] = defaultdict(dict)

    for pergunta in perguntas:
        tabela: dict[str, tuple[int, int]] = defaultdict(lambda: (0, 0))
        for lead in leads:
            resposta = lead["respostas"].get(pergunta) or SEM_RESPOSTA
            n, c = tabela[resposta]
            tabela[resposta] = (n + 1, c + lead["comprou"])

        respostas_stats = []
        for resposta, (n, compras) in sorted(tabela.items(), key=lambda kv: -kv[1][0]):
            taxa = compras / n if n else 0.0
            lift = taxa / taxa_base if taxa_base else 0.0
            # peso = log do lift com suavização de Laplace
            taxa_suave = (compras + SUAVIZACAO * taxa_base) / (n + SUAVIZACAO)
            peso = math.log(max(taxa_suave, 1e-9) / max(taxa_base, 1e-9))
            pesos[pergunta][resposta] = peso
            respostas_stats.append({
                "resposta": resposta,
                "leads": n,
                "compras": compras,
                "taxa": round(taxa, 4),
                "lift": round(lift, 2),
                "peso": round(peso, 4),
            })

        stats_perguntas.append({
            "pergunta": pergunta,
            "cramers_v": round(_cramers_v(tabela, total, compras_total), 4),
            "respostas": respostas_stats,
        })

    stats_perguntas.sort(key=lambda p: -p["cramers_v"])

    # --- score bruto por lead ---------------------------------------------
    brutos = []
    for lead in leads:
        s = 0.0
        for pergunta in perguntas:
            resposta = lead["respostas"].get(pergunta) or SEM_RESPOSTA
            s += pesos[pergunta].get(resposta, 0.0)
        lead["_bruto"] = s
        brutos.append(s)

    # --- percentil -> 0..100 ----------------------------------------------
    ordenados = sorted(brutos)
    for lead in leads:
        pos = bisect_left(ordenados, lead["_bruto"])
        lead["score"] = round(100 * pos / max(total - 1, 1))
        lead["classe"] = "hot" if lead["score"] >= HOT else ("warm" if lead["score"] >= WARM else "cold")
        del lead["_bruto"]

    # --- impulsionadores (+/-) --------------------------------------------
    candidatos = [
        {**r, "pergunta": p["pergunta"]}
        for p in stats_perguntas
        for r in p["respostas"]
        if r["leads"] >= MIN_AMOSTRA and r["resposta"] != SEM_RESPOSTA
    ]
    positivos = sorted([c for c in candidatos if c["lift"] > 1], key=lambda c: -c["lift"])[:8]
    negativos = sorted([c for c in candidatos if c["lift"] < 1], key=lambda c: c["lift"])[:8]

    # --- calibração por faixa de score (decis) ----------------------------
    faixas = []
    for i in range(10):
        lo, hi = i * 10, (i + 1) * 10 if i < 9 else 101
        grupo = [l for l in leads if lo <= l["score"] < hi]
        n = len(grupo)
        compras = sum(1 for l in grupo if l["comprou"])
        faixas.append({
            "faixa": f"{lo}–{min(hi - 1, 100)}",
            "leads": n,
            "compras": compras,
            "taxa": round(compras / n, 4) if n else 0.0,
        })

    classes = {
        classe: {
            "leads": sum(1 for l in leads if l["classe"] == classe),
            "compras": sum(1 for l in leads if l["classe"] == classe and l["comprou"]),
        }
        for classe in ("hot", "warm", "cold")
    }

    return {
        "total_leads": total,
        "total_compras": compras_total,
        "taxa_base": round(taxa_base, 4),
        "respondeu_pesquisa": sum(1 for l in leads if l["respondeu"]),
        "perguntas": stats_perguntas,
        "perguntas_descartadas": descartadas,
        "impulsionadores": {"positivos": positivos, "negativos": negativos},
        "faixas_score": faixas,
        "classes": classes,
        "parametros": {"hot": HOT, "warm": WARM, "suavizacao": SUAVIZACAO, "min_amostra": MIN_AMOSTRA},
    }
