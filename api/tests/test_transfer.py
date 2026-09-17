"""配重片转移：真实 HTTP + 真实 PostgreSQL 的端到端验收，不使用任何假接口。"""

import threading
from concurrent.futures import ThreadPoolExecutor

import httpx


def load_piece(base_url, batten_id, piece_id, weight_grams):
    return httpx.post(
        f"{base_url}/api/battens/{batten_id}/loads",
        json={"piece_id": piece_id, "weight_grams": weight_grams},
        timeout=30,
    )


def transfer(base_url, batten_id, piece_id, target_id):
    return httpx.post(
        f"{base_url}/api/battens/{batten_id}/loads/{piece_id}/transfer",
        json={"target_batten_id": target_id},
        timeout=30,
    )


def batten_state(base_url, batten_id):
    resp = httpx.get(f"{base_url}/api/battens/{batten_id}", timeout=10)
    assert resp.status_code == 200
    return resp.json()


def test_transfer_success_moves_piece_and_keeps_registration(base_url):
    """成功转移：两杆总重、余量与明细刷新，原始重量与登记时间保留。"""
    assert load_piece(base_url, "G-01", "CW-MV-1", 20000).status_code == 201
    created_at = batten_state(base_url, "G-01")["loads"][0]["created_at"]

    resp = transfer(base_url, "G-01", "CW-MV-1", "G-02")
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["piece_id"] == "CW-MV-1"
    assert body["from_batten_id"] == "G-01"
    assert body["to_batten_id"] == "G-02"
    assert body["weight_grams"] == 20000
    assert body["from"]["total_grams"] == 0
    assert body["from"]["remaining_grams"] == 30000
    assert body["to"]["total_grams"] == 20000
    assert body["to"]["remaining_grams"] == 30000

    source = batten_state(base_url, "G-01")
    assert source["total_grams"] == 0
    assert source["remaining_grams"] == 30000
    assert source["loads"] == []

    target = batten_state(base_url, "G-02")
    assert target["total_grams"] == 20000
    assert target["remaining_grams"] == 30000
    assert len(target["loads"]) == 1
    moved = target["loads"][0]
    assert moved["piece_id"] == "CW-MV-1"
    # 只更新归属：原始重量与登记时间不变
    assert moved["weight_grams"] == 20000
    assert moved["created_at"] == created_at


def test_transfer_over_capacity_leaves_both_battens_unchanged(base_url):
    """目标余量不足：明确拒绝，数据库保持原归属。"""
    assert load_piece(base_url, "G-01", "CW-MV-2", 20000).status_code == 201
    assert load_piece(base_url, "G-02", "CW-MV-3", 25000).status_code == 201
    assert load_piece(base_url, "G-02", "CW-MV-4", 15000).status_code == 201

    # G-02 余量 10000 克，容不下 20000 克的 CW-MV-2
    resp = transfer(base_url, "G-01", "CW-MV-2", "G-02")
    assert resp.status_code == 409
    body = resp.json()
    assert body["accepted"] is False
    assert body["reason"] == "OVER_CAPACITY"

    source = batten_state(base_url, "G-01")
    assert source["total_grams"] == 20000
    assert [l["piece_id"] for l in source["loads"]] == ["CW-MV-2"]
    target = batten_state(base_url, "G-02")
    assert target["total_grams"] == 40000
    assert [l["piece_id"] for l in target["loads"]] == ["CW-MV-3", "CW-MV-4"]


def test_transfer_to_same_batten_is_rejected(base_url):
    assert load_piece(base_url, "G-01", "CW-MV-4", 5000).status_code == 201
    resp = transfer(base_url, "G-01", "CW-MV-4", "G-01")
    assert resp.status_code == 409
    assert resp.json()["reason"] == "SAME_BATTEN"

    state = batten_state(base_url, "G-01")
    assert state["total_grams"] == 5000
    assert [l["piece_id"] for l in state["loads"]] == ["CW-MV-4"]


def test_transfer_to_unknown_batten_is_rejected(base_url):
    assert load_piece(base_url, "G-01", "CW-MV-5", 5000).status_code == 201
    resp = transfer(base_url, "G-01", "CW-MV-5", "G-99")
    assert resp.status_code == 404
    assert resp.json()["reason"] == "BATTEN_NOT_FOUND"

    state = batten_state(base_url, "G-01")
    assert state["total_grams"] == 5000
    assert [l["piece_id"] for l in state["loads"]] == ["CW-MV-5"]


def test_transfer_piece_not_on_source_reports_position_changed(base_url):
    """配重片已被其他终端移走（或不在源杆上）：返回“当前位置已变化”。"""
    assert load_piece(base_url, "G-02", "CW-MV-6", 5000).status_code == 201

    resp = transfer(base_url, "G-01", "CW-MV-6", "G-02")
    assert resp.status_code == 409
    body = resp.json()
    assert body["accepted"] is False
    assert body["reason"] == "PIECE_NOT_ON_SOURCE"
    assert "当前位置已变化" in body["message"]

    # 归属不变，两杆状态不受失败请求影响
    assert batten_state(base_url, "G-01")["loads"] == []
    target = batten_state(base_url, "G-02")
    assert target["total_grams"] == 5000
    assert [l["piece_id"] for l in target["loads"]] == ["CW-MV-6"]


def test_concurrent_opposite_transfers_never_overload(base_url):
    """G-01→G-02 与 G-02→G-01 同时转移：固定顺序加锁避免死锁，
    无论哪笔先获锁，结束后两杆均不超限且总重量守恒。"""
    assert load_piece(base_url, "G-01", "CW-SWAP-A", 20000).status_code == 201
    assert load_piece(base_url, "G-02", "CW-SWAP-B", 25000).status_code == 201

    barrier = threading.Barrier(2)

    def submit(args):
        source, piece, target = args
        barrier.wait(timeout=10)
        return transfer(base_url, source, piece, target)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                submit,
                [("G-01", "CW-SWAP-A", "G-02"), ("G-02", "CW-SWAP-B", "G-01")],
            )
        )

    # 无死锁、无 5xx：两笔都在行锁上正常排队裁决。
    # 先获锁的方向决定结果：A 先走则两笔都成功；B 先走则 B 超载被拒。
    statuses = sorted(r.status_code for r in responses)
    assert statuses in ([200, 200], [200, 409]), f"并发转移结果异常: {statuses}"

    g01 = batten_state(base_url, "G-01")
    g02 = batten_state(base_url, "G-02")
    # 两杆均不超限
    assert g01["total_grams"] <= g01["capacity_grams"]
    assert g02["total_grams"] <= g02["capacity_grams"]
    # 总重量守恒，两片各自完整落在一杆上
    assert g01["total_grams"] + g02["total_grams"] == 20000 + 25000
    placed = sorted(l["piece_id"] for l in g01["loads"] + g02["loads"])
    assert placed == ["CW-SWAP-A", "CW-SWAP-B"]

    if statuses == [200, 200]:
        # A 先移出 G-01：两片归属互换
        assert g01["total_grams"] == 25000
        assert [l["piece_id"] for l in g01["loads"]] == ["CW-SWAP-B"]
        assert g02["total_grams"] == 20000
        assert [l["piece_id"] for l in g02["loads"]] == ["CW-SWAP-A"]
    else:
        # B 先试图挤进 G-01 被超载拒绝，归属保持；随后 A 成功移到 G-02
        loser = next(r for r in responses if r.status_code == 409).json()
        assert loser["accepted"] is False
        assert loser["reason"] == "OVER_CAPACITY"
        assert g01["total_grams"] == 0
        assert g02["total_grams"] == 45000
        assert sorted(l["piece_id"] for l in g02["loads"]) == ["CW-SWAP-A", "CW-SWAP-B"]
