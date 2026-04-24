import streamlit as st
import yfinance as yf
import pandas as pd
import pandas_ta as ta
import os
from datetime import datetime

# ASETUKSET
st.set_page_config(page_title="AI Oppiva Treidaaja V9", layout="wide")
SYMBOL = st.sidebar.text_input("Symboli (esim. BTC-USD)", "BTC-USD")
MEMORY_FILE = "trade_memory.csv"

# 1. BOTIN MUISTIN ALUSTUS
if not os.path.exists(MEMORY_FILE):
    df_memory = pd.DataFrame(columns=["Aika", "Hinta", "Signaali", "RSI", "ADX", "Tulos"])
    df_memory.to_csv(MEMORY_FILE, index=False)

def lataa_muisti():
    return pd.read_csv(MEMORY_FILE)

def tallenna_muistiin(hinta, signaali, rsi, adx):
    muisti = lataa_muisti()
    uusi_rivi = {
        "Aika": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "Hinta": hinta,
        "Signaali": signaali,
        "RSI": rsi,
        "ADX": adx,
        "Tulos": "Odottaa"
    }
    muisti = pd.concat([muisti, pd.DataFrame([uusi_rivi])], ignore_index=True)
    muisti.to_csv(MEMORY_FILE, index=False)

# 2. DATAN HAKU JA ANALYYSI
df = yf.download(SYMBOL, period="5d", interval="5m")
if isinstance(df.columns, pd.MultiIndex):
    df.columns = df.columns.get_level_values(0)

df['RSI'] = ta.rsi(df['Close'], length=14)
df['EMA200'] = ta.ema(df['Close'], length=200)
df['ADX'] = ta.adx(df['High'], df['Low'], df['Close'])['ADX_14']

viimeisin = df.iloc[-1]
hinta = viimeisin['Close']
rsi = viimeisin['RSI']
adx = viimeisin['ADX']
ema = viimeisin['EMA200']

# 3. OPPIVA LOGIIKKA (Yksinkertaistettu AI)
muisti = lataa_muisti()
onnistuneet = muisti[muisti['Tulos'] == "Voitto"]
tarkkuus = (len(onnistuneet) / len(muisti) * 100) if len(muisti) > 0 else 100

# Päätöksenteko
signaali = "ODOTA"
luottamus = 50

if rsi < 30 and hinta > ema:
    signaali = "OSTA"
    luottamus = 75 if rsi < 25 else 60
elif rsi > 70 or hinta < ema * 0.98:
    signaali = "MYY"
    luottamus = 80

# 4. KÄYTTÖLIITTYMÄ
st.title(f"🤖 AI Treidaaja: {SYMBOL}")
col1, col2, col3 = st.columns(3)
col1.metric("Hinta", f"{hinta:.2f}")
col2.metric("Botin Tarkkuus", f"{tarkkuus:.1f}%")
col3.header(f"SUOSITUS: {signaali}")

st.progress(luottamus / 100, text=f"AI Luottamus: {luottamus}%")

if st.button("Tallenna tämä tilanne muistiin (Opetus)"):
    tallenna_muistiin(hinta, signaali, rsi, adx)
    st.success("Tallennettu! Botti vertaa tätä hintaa tulevaisuudessa.")

st.subheader("Botin historia ja oppiminen")
st.write(muisti.tail(10))

# Työkalu tulosten tarkistamiseen (Botti "opiskelee" menneet)
if st.button("Päivitä menneet tulokset (Botti oppii virheistään)"):
    muisti = lataa_muisti()
    for i, row in muisti.iterrows():
        if row['Tulos'] == "Odottaa":
            nykyhinta = hinta
            alkuhinta = row['Hinta']
            if row['Signaali'] == "OSTA":
                muisti.at[i, 'Tulos'] = "Voitto" if nykyhinta > alkuhinta else "Tappio"
            elif row['Signaali'] == "MYY":
                muisti.at[i, 'Tulos'] = "Voitto" if nykyhinta < alkuhinta else "Tappio"
    muisti.to_csv(MEMORY_FILE, index=False)
    st.rerun()
