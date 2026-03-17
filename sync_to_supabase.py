"""
sync_to_supabase.py
-------------------
Utility for pushing bank data to FinFamily via the bank-push Edge Function.
Add this file to each local scraper (pagi-api, cal-api, hapoalim-api).

Usage:
    from sync_to_supabase import push_to_supabase

    push_to_supabase("pagi", transactions, balance=current_balance)
    push_to_supabase("cal", transactions)
    push_to_supabase("hapoalim", transactions, balance=current_balance)

Transaction format:
    {
        "date": "2026-03-15",           # YYYY-MM-DD
        "description": "העברה נכנסת",
        "credit": 1500.00,              # income (positive)
        "debit": None,                  # expense (positive value)
        # OR:
        "amount": -1500.00              # negative = expense, positive = income
    }
"""

import httpx
from datetime import datetime

SUPABASE_URL = "https://tzhhilhiheekhcpdexdc.supabase.co"
SUPABASE_PUSH_URL = f"{SUPABASE_URL}/functions/v1/bank-push"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR6aGhpbGhpaGVla2hjcGRleGRjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwOTUwOTI1MCwiZXhwIjoxODY2NzE4ODUwfQ.zWgQZNBLqGI1DJQxVUGDXhXAUSc_VDYyCplkjqLwFhk"
SCRAPER_API_KEY = "28584233-c31d-411d-8211-513c725cc949"

USER_ID = "16274024-a305-4416-ba62-9b321669d7d6"   # yklein89@gmail.com

# Cache for auto-detected account IDs per source
_account_id_cache: dict[str, str] = {}


def _fetch_account_id(source: str, user_id: str) -> str:
    """Auto-detect ACCOUNT_ID from Supabase accounts table by bank_name/source."""
    if source in _account_id_cache:
        return _account_id_cache[source]

    res = httpx.get(
        f"{SUPABASE_URL}/rest/v1/accounts",
        params={
            "user_id": f"eq.{user_id}",
            "or": f"(bank_name.ilike.*{source}*,name.ilike.*{source}*)",
            "select": "id,name,bank_name",
            "limit": "1",
        },
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        },
        timeout=10,
    )
    rows = res.json()
    if not rows:
        raise ValueError(
            f"No account found for source='{source}' in Supabase. "
            "Run the scraper from the FinFamily app at least once to create accounts."
        )
    account_id = rows[0]["id"]
    _account_id_cache[source] = account_id
    print(f"[{source}] 🔍 Auto-detected ACCOUNT_ID: {account_id} ({rows[0]['name']})")
    return account_id


def push_to_supabase(
    source: str,
    transactions: list,
    balance: float = None,
    user_id: str = None,
    account_id: str = None,
) -> dict:
    """
    Push scraped bank data to Supabase via bank-push Edge Function.
    ACCOUNT_ID is auto-detected from Supabase if not provided.

    Args:
        source: 'pagi' | 'cal' | 'hapoalim'
        transactions: list of transaction dicts
        balance: current account balance (optional)
        user_id: override global USER_ID
        account_id: override auto-detection

    Returns:
        dict with { ok, transactions_added, transactions_updated }
    """
    uid = user_id or USER_ID
    aid = account_id or _fetch_account_id(source, uid)

    if not uid:
        raise ValueError("USER_ID is not set in sync_to_supabase.py")

    payload = {
        "source": source,
        "user_id": uid,
        "account_id": aid,
        "transactions": transactions,
        "fetched_at": datetime.now().isoformat(),
    }
    if balance is not None:
        payload["balance"] = balance

    response = httpx.post(
        SUPABASE_PUSH_URL,
        json=payload,
        headers={
            "x-scraper-api-key": SCRAPER_API_KEY,
            "Content-Type": "application/json",
        },
        timeout=30,
    )

    result = response.json()
    status_emoji = "✅" if response.status_code == 200 else "❌"
    print(
        f"[{source}] {status_emoji} push HTTP {response.status_code} → "
        f"added: {result.get('transactions_added', '?')}, "
        f"skipped: {result.get('transactions_updated', '?')}"
    )

    if response.status_code != 200:
        raise RuntimeError(f"bank-push failed ({response.status_code}): {result}")

    return result
