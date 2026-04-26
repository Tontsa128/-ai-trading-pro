# -*- coding: utf-8 -*-


def build_market_prompt(data: dict) -> str:
    return f"""
Olet kokenut teknisen analyysin treidausavustaja.
Et anna sijoitusneuvoa etkä lupaa varmaa tuottoa.
Analysoi vain alla oleva markkinatilanne.

MARKKINADATA:
- Kohde: {data.get("symbol")}
- Aikaväli: {data.get("timeframe")}
- Hinta: {data.get("price")}
- Signaali: {data.get("signal")}
- AI-score: {data.get("score")}
- Varmuus: {data.get("confidence")} %
- Trendi: {data.get("trend")}
- Candle power: {data.get("candle_power")}
- RSI: {data.get("rsi")}
- MACD: {data.get("macd")}
- VWAP: {data.get("vwap")}
- Support: {data.get("support")}
- Resistance: {data.get("resistance")}
- Stop: {data.get("stop")}
- Target: {data.get("target")}
- RR: {data.get("rr")}

AI:N SYYT:
{data.get("reasons")}

VASTAA SUOMEKSI TÄSSÄ MUODOSSA:
1. Päätös: OSTA / MYY / ODOTA / EI TREIDIÄ
2. Varmuus %:
3. Miksi:
4. Mikä voi mennä pieleen:
5. Paras entry:
6. Stop ja target:
7. Yksi selkeä varoitus:
"""
