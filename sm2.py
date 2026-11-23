#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Modified for kaogong-naoku-re1.0: 基于 jangviktor-web/GongkaoNaoku 修改，
# 重写了间隔曲线与四档评分的映射关系（首学天数、难度系数按档分叉）。
# 原项目以 Apache License 2.0 授权，见 LICENSE 与 NOTICE。
"""SM-2 间隔重复引擎 (Anki 风格)。四档评分：忘记(1)/困难(3)/一般(4)/熟悉(5)

间隔曲线（标准档）——不同难度从第一次就拉开差距：
  熟悉(5)：首学 4 天 → 4×ease(≈2.6)×1.3 ≈ 13 天 → 指数增长
  一般(4)：首学 2 天 → 2×ease(≈2.5)×1.0 ≈ 5 天
  困难(3)：首学 1 天 → 1×ease(≈2.36)×1.2 ≈ 3 天
  忘记(1/2)：当天重练（interval=0），恢复后按对应档位重新起算
pacing（复习节奏，用户可调，乘在算出的间隔上）：
  tight 紧凑 ×0.7 / std 标准 ×1.0 / loose 舒缓 ×1.6
"""
import datetime

PACING_MULT = {"tight": 0.7, "std": 1.0, "loose": 1.6}
# 首学间隔按档位区分（这是「无论哪种难度第二天都要复习」的根因修复）
FIRST_INTERVAL = {5: 4, 4: 2, 3: 1}
# 评分对 ease 增长的影响系数（越大越容易拉长间隔）
GROW_FACTOR = {5: 1.3, 4: 1.0, 3: 1.2}

def add_days(days):
    return (datetime.date.today() + datetime.timedelta(days=days)).isoformat()

def grade_state(state, grade, pacing="std"):
    """state: dict(ease,interval,repetitions,lapses,status). grade in {1,3,4,5}.
    返回新的 dict 含 due。interval 单位=天。"""
    ease = float(state.get("ease") or 2.5)
    interval = int(state.get("interval") or 0)
    reps = int(state.get("repetitions") or 0)
    lapses = int(state.get("lapses") or 0)
    status = state.get("status") or "new"
    grade = int(grade)
    mult = PACING_MULT.get(pacing, 1.0)

    if grade < 3:  # 忘记 / relearn：当天重练
        reps = 0
        interval = 0
        if status == "review":
            lapses += 1
        status = "learning"
    else:
        reps += 1
        if reps == 1:
            # 首学（含 relearn 后恢复）：档位直接决定起点，熟悉 4 天 / 一般 2 天 / 困难 1 天
            interval = FIRST_INTERVAL[grade]
        elif reps == 2:
            # 第二次：按当前 ease 放开，从此开始指数增长
            interval = max(FIRST_INTERVAL[grade] + 1, round(interval * ease * GROW_FACTOR[grade]))
        else:
            interval = max(interval + 1, round(interval * ease * GROW_FACTOR[grade]))
        interval = max(1, round(interval * mult))
        # SM-2 ease 更新
        ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
        if ease < 1.3:
            ease = 1.3
        status = "review" if reps >= 2 else "learning"

    due = add_days(interval)
    return dict(ease=round(ease, 3), interval=interval, repetitions=reps,
                lapses=lapses, status=status, due=due)

# 掌握度分桶（用于总览统计），基于 interval
def mastery_bucket(interval):
    if interval <= 0:
        return "学习中"
    if interval < 7:
        return "初记"
    if interval < 21:
        return "短期"
    if interval < 60:
        return "长期"
    return "稳固"
