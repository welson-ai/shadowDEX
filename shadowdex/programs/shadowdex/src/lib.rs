use anchor_lang::prelude::*;

declare_id!("HczPXyfpBMCkeyR1Z2GptoxtbmWRRpUvsvjZ9iCyMwwq");

#[program]
pub mod shadowdex {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
