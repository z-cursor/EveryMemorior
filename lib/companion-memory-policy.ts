const HEALTH = /(病|症|癌|炎|感染|骨折|疼痛|血压|血糖|血脂|心脏|中风|痴呆|过敏|障碍|综合征|抑郁|焦虑|诊断|患者|吃药|用药|药物|药片|降压片|胶囊|胰岛素|处方|服用|服药|手术|住院|艾滋|HIV|AIDS|diagnos|disease|disorder|syndrome|medication|hospital)/iu;
const MEDICATION = /(?:(?:我|本人)|(?:每天|每晚|每周|早上|晚上|睡前|饭前|饭后)[^，。！？,;]{0,8})服(?:[一-鿿]{1,7}(?:平|林|素|片|丸|剂)|[一-鿿]{1,6}胶囊)/iu;
const BEREAVEMENT = /(去世|离世|过世|不在了|扫墓|祭奠|丧亲|葬礼|遗孀|鳏夫|bereav|funeral|widow)/iu;
const TRAUMA = /(创伤|虐待|暴力|性侵|车祸|灾难|PTSD|trauma|abuse|assault)/iu;
const ADDRESS = /(住在|住址|地址|小区|门牌|号楼|邮编|(?:街道|路|巷|弄)\s*\d|address|postcode|zip code)/iu;
const FINANCE = /(银行卡|负债|欠款|房贷|车贷|贷款|工资|薪资|收入|资产|贫困|中产|富裕|经济(?:状况|困难)|财务(?:状况|困难)|退休金|存款|debt|mortgage|salary|income|asset|financial)/iu;
const FAMILY_CONFLICT = /((?:父亲|母亲|爸|妈|女儿|儿子|老伴|丈夫|妻子|家人|家庭).{0,8}(?:不孝|矛盾|冲突|争吵|吵架|疏远|断绝|不和)|家里吵架|family.{0,16}(?:conflict|estranged|argument))/iu;
const PERSONALITY = /(人格|性格|内向|外向|讨好型|回避型|控制型|MBTI|自恋|偏执|personality|introvert|extrovert|people[- ]pleaser)/iu;

const ORDINARY_TOPICS = [
  ["茶", /(茶|咖啡|牛奶|果汁)/u],
  ["饮食", /(早饭|午饭|晚饭|水果|蔬菜|烹饪|做饭)/u],
  ["散步运动", /(散步|走路|运动|太极|瑜伽|游泳)/u],
  ["阅读听书", /(评书|阅读|看书|读书|听书)/u],
  ["戏曲音乐", /(京剧|戏曲|音乐|歌曲|唱歌)/u],
  ["园艺手工", /(园艺|种花|养花|书法|画画|手工|编织)/u],
  ["棋牌益智", /(下棋|象棋|围棋|数独|拼图)/u],
] as const;

export function containsSensitiveCompanionInformation(value: string): boolean {
  return [HEALTH, MEDICATION, BEREAVEMENT, TRAUMA, ADDRESS, FINANCE, FAMILY_CONFLICT].some((pattern) => pattern.test(value));
}

export function containsProhibitedCompanionProfileContent(value: string): boolean {
  const familyConclusion = /(?:婆婆|公公|父亲|母亲|爸|妈|女儿|儿子|老伴|丈夫|妻子|家人).{0,10}(?:讨厌|不喜欢|偏心|不孝|看不起|对我不好|爱我)/u;
  return containsSensitiveCompanionInformation(value) || PERSONALITY.test(value) || familyConclusion.test(value);
}

export function ordinaryCompanionTopics(value: string): string[] {
  return ORDINARY_TOPICS.flatMap(([label, pattern]) => pattern.test(value) ? [label] : []);
}

export function normalizedOrdinaryCompanionMemory(value: string): string | null {
  const memories = value.split(/(?:但是|不过|而且|同时|但|而)|[，。；！？,;]/u).flatMap((clause) => {
    const topics = ordinaryCompanionTopics(clause);
    if (topics.length === 0) return [];
    const frequency = clause.match(/(每天|每周|平时|通常)/u)?.[1] ?? "";
    const time = clause.match(/(早上|早晨|上午|下午|晚上|睡前|[0-9零一二三四五六七八九十]{1,3}点)/u)?.[1] ?? "";
    const preference = /不喜欢|不爱/u.test(clause) ? "不喜欢" : /喜欢|偏好|爱/u.test(clause) ? "喜欢" : "日常习惯";
    const safeDetails = topics.flatMap((topic) => topic === "茶"
      ? [...clause.matchAll(/茉莉花茶|绿茶|红茶|普洱茶|乌龙茶|咖啡|牛奶|果汁|茶/gu)].map((match) => match[0])
      : [topic]);
    return [`${[frequency, time, preference].filter(Boolean).join("·")}：${[...new Set(safeDetails)].join("、")}`];
  });
  return memories.length > 0 ? memories.join("；") : null;
}

export function sensitiveCompanionTerms(value: string): string[] {
  const terms = new Set(value.match(/高血压|低血压|糖尿病|癌症|艾滋病|抑郁症|焦虑症|双相情感障碍|银行卡|房贷|车贷|负债|欠款|工资|薪资|收入|资产|退休金|存款|经济困难|财务困难|创伤|虐待|性侵|车祸|PTSD/giu) ?? []);
  for (const match of value.matchAll(/[一-鿿]{1,12}(?:病|症|癌|炎|感染|骨折|疼痛|障碍|综合征)/gu)) {
    const entity = match[0].replace(/^(?:(?:最近|这阵子)|我(?:的|有|患有|得了)?|本人(?:有|患有)?|患有|确诊(?:为)?|得了)+/u, "");
    if (entity.length >= 2 && !["病症", "症状", "障碍", "综合征", "疼痛"].includes(entity)) terms.add(entity);
    const stem = entity.replace(/(?:综合征|障碍|感染|骨折|疼痛|病|症|癌|炎)$/u, "");
    if (stem.length >= 2) terms.add(stem);
  }
  for (const match of value.matchAll(/(?:服用?|服药|吃药|用药)([一-鿿A-Za-z0-9-]{2,16})/gu)) terms.add(match[1]);
  for (const match of value.matchAll(/(?:(?:我|本人)|(?:每天|每晚|每周|早上|晚上|睡前|饭前|饭后)[^，。！？,;]{0,8})服([一-鿿]{1,7}(?:平|林|素|片|丸|剂)|[一-鿿]{1,6}胶囊)/gu)) terms.add(match[1]);
  for (const match of value.matchAll(/(?:住在|住址(?:是|为)?|地址(?:是|为)?)([^，。！？,;\s]{2,24})/gu)) {
    terms.add(match[1]);
    for (let length = 3; length <= Math.min(8, match[1].length); length += 1) {
      const suffix = match[1].slice(-length);
      if (/(?:省|市|区|县|镇|村|街道|路|巷|弄|小区|号楼|号)$/u.test(suffix)) terms.add(suffix);
    }
  }

  const relationships = value.match(/父亲|母亲|爸|妈|女儿|儿子|老伴|丈夫|妻子|家人|家庭/gu) ?? [];
  const losses = value.match(/去世|离世|过世|不在了|扫墓|祭奠|丧亲|葬礼/gu) ?? [];
  const conflicts = value.match(/不孝|矛盾|冲突|争吵|吵架|疏远|断绝|不和/gu) ?? [];
  for (const relationship of relationships) {
    for (const loss of losses) terms.add(`loss:${relationship}:${loss}`);
    for (const conflict of conflicts) terms.add(`conflict:${relationship}:${conflict}`);
  }
  return [...terms].filter((term) => term.length >= 2);
}
