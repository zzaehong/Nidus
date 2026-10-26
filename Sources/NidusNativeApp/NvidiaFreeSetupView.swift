import SwiftUI

struct NvidiaFreeSetupView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = RoutingSettingsModel()
    @State private var selected = Set<String>()
    @State private var confirmed = false
    @State private var riskAccepted = false
    private var candidates: [RoutingSettingsSnapshot.TierModel] {
        (model.snapshot?.models ?? []).filter { $0.provider == "nvidia" && $0.pricing.freeTier == "available" && $0.capabilities.chat != "unsupported" }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("NVIDIA Free Only 계정 확인").font(.title2.bold())
            Text("계정: \(model.snapshot?.providerPlans?.first(where: { $0.provider == "nvidia" })?.state ?? "unknown") · 공식 무료 지원이 확인된 현재 조회 모델 \(candidates.count)개")
            Text("현재 계정을 Free Only로 확인하고 선택 모델의 무료 상태를 기록합니다. 공식 무료 지원 모델만 실행하며 저장만으로 API를 호출하지 않습니다.")
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(candidates) { item in
                        VStack(alignment: .leading) {
                            Toggle(item.modelID, isOn: Binding(get: { selected.contains(item.modelID) }, set: { if $0 { selected.insert(item.modelID) } else { selected.remove(item.modelID) } }))
                            Text(item.freeUse?.approved == true ? "무료 추정 설정됨" : "무료 추정 미설정").font(.caption)
                            if let url = URL(string: item.pricing.sourceUrl) { Link("공식 Free Endpoint 확인", destination: url).font(.caption) }
                        }
                    }
                    if candidates.isEmpty { Text("현재 조회 목록에 검토된 무료 텍스트 모델이 없습니다. 모델 목록을 새로고침하세요. 목록 밖의 모델을 임의로 무료 처리하지 않습니다.") }
                }
            }.frame(maxHeight: 250)
            Toggle("현재 키에 무료 개발자 계정 권한이 있으며 선택 모델의 Free Endpoint를 확인했습니다", isOn: $confirmed)
            Toggle("사용자 확인은 실제 Billing 보증이 아니며 잘못 설정하면 과금될 수 있음을 이해합니다", isOn: $riskAccepted)
            Text("개발·평가용 NVIDIA 호스팅 API에 한정합니다. 남은 할당량은 미조회입니다. 다른 모델·유료 플랜·자체 호스팅에는 무료 추정을 적용하지 않습니다. 자동 라우팅의 Tier는 별도로 배정하세요.").font(.caption).foregroundStyle(.secondary)
            if let error = model.error { Text(error).foregroundStyle(.red) }
            HStack {
                Button("닫기") { dismiss() }
                Spacer()
                Button("Free Only 확인 및 모델 상태 저장") { Task {
                    await model.perform(["method":"nvidia-free-setup", "models":selected.sorted(), "confirmed":confirmed, "riskAccepted":riskAccepted])
                    if model.error == nil { dismiss() }
                }}.disabled(model.busy || selected.isEmpty || !confirmed || !riskAccepted)
            }
        }.padding(24).frame(width: 750)
        .task { await model.perform() }
        .onChange(of: selected) { _ in confirmed = false; riskAccepted = false }
    }
}
