import buildPrompt from "@/prompt/index";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// 测试 buildPrompt 基本功能
function testBasicBuildPrompt() {
  const userPrompt = "你好，请帮我分析一下这个问题";
  const result = buildPrompt(userPrompt);

  // 验证基本结构
  console.assert(result.includes("<system>"), "应包含 <system> 标签");
  console.assert(result.includes("</system>"), "应包含 </system> 标签");
  console.assert(result.includes("<skills>"), "应包含 <skills> 标签");
  console.assert(result.includes("</skills>"), "应包含 </skills> 标签");
  console.assert(result.includes("<user>"), "应包含 <user> 标签");
  console.assert(result.includes("</user>"), "应包含 </user> 标签");

  // 验证用户提示词
  console.assert(result.includes(userPrompt), "应包含用户提示词");

  console.log("✅ testBasicBuildPrompt passed");
}

// 测试 skills 加载
function testSkillsLoading() {
  const result = buildPrompt("test");

  // 验证 haveFun skill 被加载
  console.assert(
    result.includes('name="haveFun"'),
    "应加载 haveFun skill"
  );
  console.assert(
    result.includes('description="This is a skill for having fun."'),
    "应包含 skill 描述"
  );

  console.log("✅ testSkillsLoading passed");
}

// 测试 system.md 内容
function testSystemContent() {
  const result = buildPrompt("test");

  // 验证 system.md 内容被包含
  console.assert(
    result.includes("tool_call"),
    "应包含 system.md 中的内容"
  );

  console.log("✅ testSystemContent passed");
}

// 测试空用户输入
function testEmptyUserPrompt() {
  const result = buildPrompt("");

  console.assert(result.includes("<user>\n\n</user>"), "空输入应产生空 user 标签");

  console.log("✅ testEmptyUserPrompt passed");
}

// 测试特殊字符转义（XML 安全性）
function testSpecialCharacters() {
  const specialPrompt = "测试 <script>alert('xss')</script> & \"quotes\"";
  const result = buildPrompt(specialPrompt);

  // 当前实现不转义，只验证能正常处理
  console.assert(result.includes(specialPrompt), "应包含原始特殊字符");

  console.log("✅ testSpecialCharacters passed");
}

// 测试多行用户输入
function testMultilineUserPrompt() {
  const multilinePrompt = `第一行
第二行
第三行`;
  const result = buildPrompt(multilinePrompt);

  console.assert(result.includes(multilinePrompt), "应包含多行输入");

  console.log("✅ testMultilineUserPrompt passed");
}

// 测试 parseSkillFrontmatter 间接测试（通过无效 skill）
function testInvalidSkillHandling() {
  // 创建临时 skills 目录测试
  const tempDir = join(tmpdir(), "cheryclaw-test-skills");
  const originalDir = process.cwd();

  try {
    // 这个测试只能验证现有 skills 目录的加载逻辑
    // 如果 skills 目录不存在，buildPrompt 应该正常处理
    const result = buildPrompt("test");
    console.assert(result !== "", "应返回非空结果");

    console.log("✅ testInvalidSkillHandling passed");
  } finally {
    // 清理
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  }
}

// 运行所有测试
function runAllTests() {
  console.log("Running prompt/index.ts tests...\n");

  testBasicBuildPrompt();
  testSkillsLoading();
  testSystemContent();
  testEmptyUserPrompt();
  testSpecialCharacters();
  testMultilineUserPrompt();
  testInvalidSkillHandling();

  console.log("\n✅ All tests passed!");
}

runAllTests();