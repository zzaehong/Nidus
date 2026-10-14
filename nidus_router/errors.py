MESSAGES = {
    "invalid_request": "요청 형식을 확인하세요.",
    "unauthorized": "인증이 필요합니다.",
    "forbidden": "허용되지 않은 접근입니다.",
    "not_found": "대상을 찾을 수 없습니다.",
    "configuration_conflict": "설정이 변경되었거나 다른 설정에서 사용 중입니다. 새로고침 후 참조와 승인 조건을 확인하세요.",
    "credential_unavailable": "OS 자격 증명 저장소의 키를 확인하세요.",
    "no_available_model": "사용 가능한 모델이 없습니다.",
    "unknown_pricing": "모델의 요금 분류 또는 요율을 설정하세요.",
    "paid_not_approved": "유료 모델과 월간 예산의 사전 승인이 필요합니다.",
    "budget_exceeded": "이번 달 잔여 예산이 부족합니다.",
    "authentication_failed": "공급자 인증에 실패했습니다.",
    "rate_limited": "공급자의 사용 한도에 도달했습니다.",
    "provider_unavailable": "공급자 연결 또는 서버에 문제가 있습니다.",
    "provider_request_rejected": "공급자가 요청을 거부했습니다.",
    "invalid_output": "응답이 비어 있거나 불완전하거나 지정한 형식에 맞지 않습니다.",
    "json_stream_not_supported": "JSON 모드에서는 stream=false를 사용하세요.",
    "cancelled": "클라이언트 연결이 종료되었습니다.",
    "internal_error": "라우터 내부 오류가 발생했습니다.",
}


class RouterError(Exception):
    def __init__(self, code, status=502, retryable=False):
        self.code, self.status, self.retryable = code, status, retryable
        super().__init__(code)

    def body(self, request_id):
        return {"request_id": request_id, "error": {
            "code": self.code, "message": MESSAGES.get(self.code, MESSAGES["internal_error"])}}
