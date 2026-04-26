# -*- coding: utf-8 -*-

from .gpt_client import ask_gpt
from .gpt_prompts import build_market_prompt


def analyze_market_with_gpt(api_key: str, market_data: dict) -> str:
    prompt = build_market_prompt(market_data)
    return ask_gpt(api_key, prompt)
