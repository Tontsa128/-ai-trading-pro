# -*- coding: utf-8 -*-

from openai import OpenAI


def ask_gpt(api_key: str, prompt: str, model: str = "gpt-5.5") -> str:
    if not api_key or not api_key.strip():
        return "OpenAI API -avain puuttuu."

    try:
        client = OpenAI(api_key=api_key.strip())

        response = client.responses.create(
            model=model,
            input=prompt,
        )

        return response.output_text

    except Exception as e:
        return f"GPT-virhe: {e}"
