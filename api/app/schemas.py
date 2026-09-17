from pydantic import BaseModel, Field, StrictInt


class LoadCreate(BaseModel):
    piece_id: str = Field(min_length=1, max_length=128)
    # 严格整数：字符串 "100"、小数 100.0、布尔值一律拒绝，不做隐式转换
    weight_grams: StrictInt


class TransferCreate(BaseModel):
    # 转移只改归属：配重片沿用已登记的原始重量与登记时间，请求里不接受重量
    piece_id: str = Field(min_length=1, max_length=128)
    target_batten_id: str = Field(min_length=1, max_length=32)
